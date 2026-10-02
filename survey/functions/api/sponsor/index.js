// Step 1 of a sponsored response (see `cip179/sponsor.js`): after the
// Turnstile check, the transaction the sponsor built and signed for the
// response.
//
//   POST { challenge, payload: <label-17 CBOR hex> } → { tx, txId }

import { reply, sponsor, SponsorError } from "../../../cip179/sponsor.js";

const TURNSTILE_SECRET_ENV_VAR = "state-of-the-developer-ecosystem-2025-turnstile";

export const onRequestPost = ({ request, env }) =>
  reply(async () => {
    const { challenge, payload } = await request.json();
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    if (!(await validateTurnstile(env[TURNSTILE_SECRET_ENV_VAR], challenge, ip))) {
      throw new SponsorError("invalid turnstile verification");
    }
    return sponsor(env, payload);
  });

async function validateTurnstile(secret, challenge, remoteip) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", challenge ?? "");
  if (remoteip) body.append("remoteip", remoteip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const { success } = await res.json();
  return success;
}
