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

## Monitor and control it from Home Assistant

The add-on can show up in Home Assistant as a device called **Public Access** (it speaks the ESPHome protocol, so
no extra integration is needed). In the panel, choose **Add to Home Assistant**. The connection is encrypted with a
key the add-on generates and keeps in `/data`.

| Entity | What it is |
| --- | --- |
| Status, Home Assistant link | Whether it is serving, paused, or waiting for Home Assistant |
| Visitors, Visits, Visitors on *host* | Live connections, total visits, and live connections per address |
| Refused requests, Rate limited | Counters; a sudden rise means someone is probing |
| Published entities | How many entities visitors can read across all addresses |
| Serve visitors (switch) | Off pauses everything: visitors are disconnected and pages answer 503 |
| Publish *host* (switch) | Hides one address (404) without deleting it |
| Most visitors, Most connections per visitor | Limits, changed live; saved and kept across restarts |
| Log level | Changes the add-on log level live |
| Disconnect all visitors, Reload published view | Buttons |

Use these in automations: pause public access when the alarm is armed, or notify when Refused requests jumps.
Adding or removing an address in the panel restarts the device for a few seconds; Home Assistant reconnects and
keeps the history of the entities that remain. Turn the device off with the *Show as a Home Assistant device* option.

Values you set from Home Assistant are saved and win over the add-on options until you change them there again.

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
| Show as a Home Assistant device | Adds the Public Access device described above. On by default. |
| Publications | Used only to seed a fresh install. Use the panel afterwards. |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The page shows nothing or "Upstream error" | Open the add-on log. The most common cause is a wrong *Home Assistant address* (HTTPS enabled in Core). |
| Visitors see no entities | The view may use a strategy, or the URL of the view changed. Check the panel's preview. |
| 429 or 503 | A limit was reached (wait a minute or raise the limits), or **Serve visitors** is off in Home Assistant. |
| Adding the device in Home Assistant says it cannot connect | Home Assistant must be able to reach this add-on by its host name (shown on the Info tab) on port 6053. Check the add-on log for ESPHome messages. |
| Every visitor seems to be the same address | The add-on only trusts forwarded addresses from the internal network. Connect Cloudflared to it over the add-on network, not through a published host port. |
