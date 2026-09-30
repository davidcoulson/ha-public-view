# ha-public-view

A Home Assistant add-on that shares **one view of one dashboard** with anyone, read-only, with no login. Visitors
get your real dashboard (custom cards and history charts included) but cannot press, save or run anything.
It is built to sit behind the **Cloudflared** add-on, so only this add-on is reachable from the internet, never
Home Assistant itself.

```
visitor ─▶ Cloudflare ─▶ Cloudflared add-on ─▶ Public Access add-on ──(read-only user)──▶ Home Assistant Core
```

## Status: early, not yet proven on a real Supervisor

Built and tested against a native Home Assistant 2026.2.3 with Node 22: 53 unit tests, 31 websocket/REST checks, 14 checks driving it from Home Assistant, and
9 browser checks all pass. **Not yet run:** the Docker image, a real Supervisor install, Home Assistant 2026.9,
or the GitHub Actions workflow. Expect rough edges, and please
[open an issue](../../issues) with what you find. Treat it as something to try on a test setup first, and read
[how it keeps visitors read-only](public-access/README.md#decisions-worth-knowing) before exposing anything private.

## Install

1. In Home Assistant: **Settings > Add-ons > Add-on store > ⋮ > Repositories**, add
   `https://github.com/davidcoulson/ha-public-view`.
2. Install **Public Access**, start it, and open **Public Access** in the sidebar.
3. Add a publication (host name, dashboard, view), check the preview of what visitors can read, and save.
4. Paste the snippet the panel shows into the **Cloudflared** add-on's `additional_hosts`, and restart it.

Details, limits and troubleshooting: [public-access/DOCS.md](public-access/DOCS.md).

## What is in this repository

| Path | What |
| --- | --- |
| [`public-access/`](public-access) | The add-on: TypeScript on Node, tests, packaging |
| [`docs/m0-spike/`](docs/m0-spike) | The feasibility spike and its findings (why the allowlist, not the read-only group, is the main lock) |
| [`.github/workflows/`](.github/workflows) | Type check and unit tests, multi-arch image build, end-to-end run against a real Home Assistant |

## Independence

This project is not affiliated with the Home Assistant project, the Open Home Foundation, Nabu Casa or Cloudflare.
It is an independent implementation of the same general idea as
[dllfpp/ha-public-access](https://github.com/dllfpp/ha-public-access), which is source-available under a different
licence. The design was informed by reading that project's public README and code; no code was copied, and the
implementation here was written separately.

## Licence

[MIT](LICENSE).
