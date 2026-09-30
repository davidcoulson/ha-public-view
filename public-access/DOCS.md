# Public Access

Share **one view of one dashboard** with anyone, read-only, with no login. Visitors see your real dashboard,
including custom cards and history charts, but cannot press, save or run anything.

## Quick start

1. Install and start this add-on, then open **Public Access** in the sidebar.
2. Under *Add a publication*, type the host name you want (for example `solar.example.com`), pick a dashboard and
   one of its views, and choose **Add and save**. The page lists what visitors will be able to read.
3. Install the **Cloudflared** add-on (Cloudflare tunnel). Copy the snippet from the *Expose it* section of this
   add-on's panel into Cloudflared's `additional_hosts`, and restart Cloudflared.
4. Open the address in a private window. You should see only that view, with no menu.

> Build a dashboard just for the public. Everything the chosen view refers to is visible to visitors, including
> cameras and maps.

## What visitors can and cannot do

- They can look, switch chart periods and read tooltips.
- Every command, save, script and template that is not text in your view is refused before it reaches Home Assistant.
- Only the entities, statistics, devices and areas the view refers to are sent to their browser. Your home's
  location, other dashboards, users and integrations are not.
- The add-on signs in to Home Assistant as its own user, **Public Access viewer**, which belongs to the read-only
  group and cannot log in from outside your network. Do not delete or edit this user.

## Views that cannot be published

- A view needs a URL: open the view's settings and fill in *URL*.
- Dashboards built by a strategy, and automatically generated ones, list no entities. Save the dashboard once from
  the editor to turn it into an explicit one.
- Cards that choose entities on their own (for example auto-entities) only show the entities named in the view.

## Limits

By default 50 visitors at once, 6 connections per address, 120 page requests a minute per address. Change the
first two in the add-on configuration.

## Options

| Option | Meaning |
| --- | --- |
| Home Assistant address | Where the add-on reaches Core. Default `http://homeassistant:8123`. |
| Log level | `debug` shows every refused request. |
| Most visitors at once | Live visitor connections in total. |
| Most connections per visitor | Live connections from one address. |
| Publications | Used only to seed a fresh install. Use the panel afterwards. |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The page shows nothing or "Upstream error" | Open the add-on log. The most common cause is a wrong *Home Assistant address* (HTTPS enabled in Core). |
| Visitors see no entities | The view may use a strategy, or the URL of the view changed. Check the panel's preview. |
| 429 or 503 | A limit was reached; wait a minute or raise the limits. |
| Every visitor seems to be the same address | The add-on only trusts forwarded addresses from the internal network. Connect Cloudflared to it over the add-on network, not through a published host port. |
