# Changelog

## 0.2.1
Security fixes. Update if the view is reachable from the internet.
- A visitor could read entities that are not in the published view, by reusing a message id or by asking Home Assistant to batch its replies. Both are closed.
- A card's template can no longer be pointed at another entity through its variables, and events no longer carry the home location.
- Disabling, removing or changing a publication disconnects its visitors, and a disabled host name answers 404 instead of showing the remaining publication.
- A malformed request can no longer stop the add-on; failed connections no longer use up visitor slots; repeated logins no longer leak connections; the message limit counts every message.
- Editing a hidden publication in the panel keeps it hidden.

## 0.2.0
- The add-on shows up in Home Assistant as an ESPHome device (using the `esphome-device` library): monitoring sensors, a pause switch, limits, per-publication switches, and buttons. One click adds it from the panel. Uses an encrypted connection.
- A patch for `esphome-device` 0.2.0 so Home Assistant's setup flow can tell the device needs an encryption key.

## 0.1.0
- First version: read-only viewer relay, single-view isolation, kiosk page, setup panel, limits.
