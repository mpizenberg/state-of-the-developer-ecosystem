# State of The Developer Ecosystem Survey

## Installation

```
yarn
```

## Configuration

- Cloudflare's turnstile sitekey in [public/js/app.js](./public/js/app.js#L4)
- Survey's questions and answers in [public/js/survey.js](./public/js/survey.js)
- Titles, dates, etc.. in [public/index.html](./public/index.html)

## Development

```
yarn dev
```

## Monitoring

Fetch results and/or answers count via:

```
yarn count
```

or

```
yarn results
```

> [!TIP]
>
> To run those commands against a remote deployed instance, you must first login into Cloudflare:
>
> ```
> yarn wrangler login
> ```
>
> And then, simply append `--remote` to the commands. For example:
>
> ```
> yarn count --remote
> yarn results --remote
> ```

## CIP-179

The survey is being moved on chain as a [CIP-179](https://github.com/mpizenberg/Tessera/blob/main/frontend/cip-179.md) survey. `cip179/build.js` turns `public/survey.json` into the CIP-179 survey definition, and reports what doesn't fit (labels over 64 bytes, unsupported conditions, the definition size, ...):

```
yarn cip179
```

With `--owner <key hash> --end-epoch <epoch> --out <dir>`, it also writes the definition as cardano-cli metadata JSON, the widget's display conditions and translations, and the mapping used to convert responses back to `answers.json` rows.

To try the survey in the widget respondents will use:

```
yarn preview
```

and open http://localhost:8179/. The survey is rebuilt from `survey.json` on every reload, with the builder's problems listed above it (labels over 64 bytes are cut instead of stopping the build). Nothing is submitted: submitting checks the response the widget gives (size, CIP-179 validity, display conditions) and shows the `answers.json` row it converts to. Unsent answers are kept in the browser until "Forget my answers".

`yarn test` runs the 2025 answers through CIP-179 responses and back, to check that mapping.

## Deployment

Deploy on Cloudflare by simply pushing the repository. The workers & pages then does its magic. Note that Turnstile secret needs to be configured in the Cloudflare dashboard directly.
