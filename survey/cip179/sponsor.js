// The transaction sponsor: puts survey responses on chain with the sponsor
// wallet paying the fee, so respondents need neither a wallet nor ada. Used by
// the Pages Functions in `functions/api/sponsor/` and by `preview.js --sponsor`.
//
// Two steps, with no state kept in between:
//
// 1. `sponsor(env, payloadHex)` checks that the label-17 payload is one valid
//    response to our survey, from a key credential. It builds a transaction
//    spending one random sponsor coin, with the payload, the credential as
//    required signer and a short validity window, and signs it.
// 2. `submit(env, txHex, witness)` adds the respondent's signature and submits
//    the transaction. Only transactions the sponsor signed are relayed: that
//    signature covers the whole body, so they are exactly as built in step 1.
//
// Config (`env`): SPONSOR_MNEMONIC (a secret), SPONSOR_NETWORK (preview or
// mainnet), SPONSOR_KOIOS (the Koios API URL) and SPONSOR_SURVEY (the
// survey's "<tx id>#<index>").

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import * as Ed25519Signature from "@evolution-sdk/evolution/Ed25519Signature";
import * as KeyHash from "@evolution-sdk/evolution/KeyHash";
import * as Transaction from "@evolution-sdk/evolution/Transaction";
import * as TransactionWitnessSet from "@evolution-sdk/evolution/TransactionWitnessSet";
import * as VKey from "@evolution-sdk/evolution/VKey";
import { mainnet, preview } from "@evolution-sdk/evolution/sdk/client/Chain";
import * as Client from "@evolution-sdk/evolution/sdk/client/Client";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import { decodeMetadata, decodePayload, describeProblems, validateResponse } from "cip-179";
import { cborToMetadatum, toTxMetadatum } from "cip-179/evolution";

// A transaction is at most 16384 bytes; this leaves room for the body and
// both signatures. The fee grows by 44 lovelace per byte.
const MAX_PAYLOAD_BYTES = 15000;
// The respondent signs right away, so a few minutes is enough. Until then,
// another transaction may pick the same sponsor coin and one of them fails.
const VALIDITY_MS = 5 * 60 * 1000;
// Coins worth less can't pay for the largest response plus the change.
const MIN_COIN = 2_000_000n;

const CHAINS = { preview, mainnet };

/** A request we refuse; its message is shown to the respondent. */
export class SponsorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The JSON response for what `work` returns, or `{ error }`. */
export async function reply(work) {
  try {
    return Response.json(await work());
  } catch (error) {
    if (error instanceof SponsorError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "malformed request" }, { status: 400 });
    console.error("sponsor:", error);
    return Response.json({ error: "the sponsor failed, please try again later" }, { status: 500 });
  }
}

/** Step 1: a signed transaction for a response payload (CBOR hex). */
export async function sponsor(env, payloadHex) {
  const config = configOf(env);
  const payloadBytes = fromHex(payloadHex, "payload");
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new SponsorError(`the response is ${payloadBytes.length} bytes, over the ${MAX_PAYLOAD_BYTES} we sponsor`);
  }
  const { payload, response } = checkedResponse(payloadBytes, config);

  const [definition, tip] = await Promise.all([surveyDefinition(config), koios(config, "tip").then(([t]) => t)]);
  const problems = describeProblems(validateResponse(definition, response));
  if (problems.length > 0) throw new SponsorError(`invalid response: ${problems.join("; ")}`);

  // The survey takes responses until the end of its end epoch; a transaction
  // can't land later than that.
  const surveyEnd = slotTime(config.chain, tip.abs_slot - tip.epoch_slot + (definition.endEpoch - tip.epoch_no + 1) * config.chain.epochLength);
  const validUntil = Math.min(Date.now() + VALIDITY_MS, surveyEnd);
  if (validUntil <= Date.now()) throw new SponsorError("the survey has ended");

  const client = Client.make(config.chain).withKoios({ baseUrl: config.koios }).withSeed({ mnemonic: config.mnemonic });
  const coins = (await client.getWalletUtxos()).filter((u) => !u.assets.multiAsset && u.assets.lovelace >= MIN_COIN);
  if (coins.length === 0) throw new Error("the sponsor wallet has no coin left");
  const coin = coins[Math.floor(Math.random() * coins.length)];

  const built = await client
    .newTx()
    .attachMetadata({ label: 17n, metadata: toTxMetadatum(payload) })
    .addSigner({ keyHash: KeyHash.fromBytes(response.credential.keyHash) })
    .setValidity({ to: BigInt(validUntil) })
    .build({ availableUtxos: [coin] });
  const witnesses = await built.partialSign();
  const tx = Transaction.addVKeyWitnessesHex(
    Transaction.toCBORHex(await built.toTransaction()),
    TransactionWitnessSet.toCBORHex(witnesses),
  );
  return { tx, txId: toHex(txIdOf(fromHex(tx, "transaction"))) };
}

/**
 * Step 2: submits a transaction from step 1 with the respondent's signature,
 * `{ vkey, signature }` in hex. Returns the transaction id.
 */
export async function submit(env, txHex, { vkey, signature }) {
  const config = configOf(env);
  const txBytes = fromHex(txHex, "transaction");
  const txId = txIdOf(txBytes);
  const tx = Transaction.fromCBORBytes(txBytes);

  const sponsorKey = addressFromSeed(config.mnemonic, { networkId: config.chain.id }).address.paymentCredential.hash;
  const signedBySponsor = (tx.witnessSet.vkeyWitnesses ?? []).some((w) => {
    const key = VKey.toBytes(w.vkey);
    return equal(keyHashOf(key), sponsorKey) && ed25519.verify(Ed25519Signature.toBytes(w.signature), txId, key);
  });
  if (!signedBySponsor) throw new SponsorError("not a transaction from the sponsor");

  const respondentKey = fromHex(vkey, "vkey");
  const respondentSignature = fromHex(signature, "signature");
  const required = (tx.body.requiredSigners ?? []).map((k) => KeyHash.toBytes(k));
  if (!required.some((k) => equal(k, keyHashOf(respondentKey)))) throw new SponsorError("not the respondent's key");
  if (!ed25519.verify(respondentSignature, txId, respondentKey)) throw new SponsorError("invalid signature");

  const respondent = new TransactionWitnessSet.TransactionWitnessSet({
    vkeyWitnesses: [
      new TransactionWitnessSet.VKeyWitness({
        vkey: VKey.fromBytes(respondentKey),
        signature: Ed25519Signature.fromBytes(respondentSignature),
      }),
    ],
  });
  const signed = Transaction.addVKeyWitnessesHex(txHex, TransactionWitnessSet.toCBORHex(respondent));
  const res = await fetch(`${config.koios}/submittx`, {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: fromHex(signed, "transaction"),
  });
  // Most likely its sponsor coin was just spent by another one: the
  // respondent can try again.
  if (!res.ok) throw new SponsorError(`the transaction was refused: ${await res.text()}`, 502);
  return toHex(txId);
}

/** The survey, network and wallet the sponsor works for. */
export function sponsorInfo(env) {
  const config = configOf(env);
  const { address } = addressFromSeed(config.mnemonic, { networkId: config.chain.id });
  return { network: config.network, survey: env.SPONSOR_SURVEY, sponsorKeyHash: toHex(address.paymentCredential.hash) };
}

// ----------------------------------------------------------------------------

function configOf(env) {
  const chain = CHAINS[env.SPONSOR_NETWORK];
  if (!chain) throw new Error(`unknown SPONSOR_NETWORK ${env.SPONSOR_NETWORK}`);
  if (!env.SPONSOR_MNEMONIC) throw new Error("no SPONSOR_MNEMONIC");
  const [, txId, index] = /^([0-9a-f]{64})#(\d+)$/.exec(env.SPONSOR_SURVEY ?? "") ?? [];
  if (!txId) throw new Error(`SPONSOR_SURVEY isn't "<tx id>#<index>": ${env.SPONSOR_SURVEY}`);
  return {
    network: env.SPONSOR_NETWORK,
    chain,
    koios: env.SPONSOR_KOIOS.replace(/\/$/, ""),
    mnemonic: env.SPONSOR_MNEMONIC,
    survey: { txId, index: Number(index) },
  };
}

/** The single response in a payload, if it is to our survey from a key. */
function checkedResponse(payloadBytes, config) {
  let payload, decoded;
  try {
    payload = cborToMetadatum(payloadBytes);
    decoded = decodePayload(payload);
  } catch (error) {
    throw new SponsorError(`not a CIP-179 payload: ${error.message}`);
  }
  if (decoded.type !== "responses" || decoded.responses.length !== 1) {
    throw new SponsorError("the payload must hold exactly one response");
  }
  const [response] = decoded.responses;
  if (toHex(response.surveyRef.txId) !== config.survey.txId || response.surveyRef.index !== config.survey.index) {
    throw new SponsorError("the response isn't to our survey");
  }
  if (response.credential.type !== "key") throw new SponsorError("the response must be from a key credential");
  return { payload, response };
}

// Definitions never change once on chain, so each instance reads it once.
const definitions = new Map();

function surveyDefinition(config) {
  const key = `${config.network} ${config.survey.txId}#${config.survey.index}`;
  if (!definitions.has(key)) {
    const read = readDefinition(config);
    read.catch(() => definitions.delete(key));
    definitions.set(key, read);
  }
  return definitions.get(key);
}

async function readDefinition(config) {
  const { txId, index } = config.survey;
  const [row] = await koios(config, "tx_cbor", { _tx_hashes: [txId] });
  if (!row) throw new Error(`the survey transaction ${txId} isn't on ${config.network}`);
  const metadatum = Transaction.fromCBORHex(row.cbor).auxiliaryData?.metadata?.get(17n);
  const definition = metadatum && decodeMetadata(new Map([[17n, metadatum]])).definitions?.[index];
  if (!definition) throw new Error(`no survey definition at ${txId}#${index}`);
  return definition;
}

async function koios(config, endpoint, body) {
  const res = await fetch(
    `${config.koios}/${endpoint}`,
    body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Koios ${endpoint}: ${res.status} ${await res.text()}`);
  return res.json();
}

function slotTime({ slotConfig }, slot) {
  return Number(slotConfig.zeroTime) + (slot - Number(slotConfig.zeroSlot)) * slotConfig.slotLength;
}

/** The transaction id: the hash of the body exactly as encoded. */
const txIdOf = (txBytes) => blake2b(Transaction.extractBodyBytes(txBytes), { dkLen: 32 });
const keyHashOf = (vkey) => blake2b(vkey, { dkLen: 28 });

const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(text, what) {
  if (typeof text !== "string" || !/^([0-9a-f]{2})*$/i.test(text)) throw new SponsorError(`${what} isn't hex`);
  return Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
}
