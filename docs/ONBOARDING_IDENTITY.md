# First-use onboarding and identity

Status: research-backed design proposal, not yet implemented.

Last reviewed: 2026-09-21

## Product goal

The first Nara device is intended to be given to a trusted recipient as a gift, while the runtime must later support many people, devices, households, and relationship types.

First-use onboarding needs to answer four separate questions:

1. Which physical device is this? — device identity.
2. Which account/person is claiming it? — account identity.
3. Is that account actually in possession of the intended device right now? — pairing/claim proof.
4. Who is speaking during a later conversation? — viewer/speaker recognition.

Do not collapse these into one spoken password or one voice profile.

## Industry pattern

Mature consumer devices move sensitive sign-in to a trusted phone/browser rather than asking the smart speaker itself to collect a password.

- Apple HomePod: setup starts by bringing an unlocked iPhone/iPad near the speaker and continuing on the phone. Voice recognition is configured separately for personalization, and some personal requests can still require authentication on the iPhone.
- Google Home/Nest: onboarding is driven from the Google Home app using a QR/setup code; Voice Match is a later personalization layer on a shared device.
- Amazon Echo devices with displays: setup can start by scanning a QR code on the Echo screen and continuing in the Alexa app.
- OAuth 2.0 Device Authorization Grant (RFC 8628): designed for input-constrained devices. A device displays a short-lived user code and/or QR link; the person authenticates and approves in a browser on a second device.
- Matter commissioning uses an onboarding payload, QR/manual setup code, and proof of possession before credentials are installed.

The repeated pattern is: **phone/browser authenticates the human; setup code/QR binds that authenticated human to the physical device.**

## Recommended Nara identity model

### Device identity

Each Nara body should have a stable device ID and a device-specific cryptographic credential.

The device credential authenticates hardware to Nara Gateway. It is not a person's password and should never be spoken.

For production, replace the current single global `NARA_DEVICE_TOKEN` with per-device credentials so compromise of one device does not authorize every Nara device.

A simple first implementation can use a high-entropy per-device bearer credential with rotation/revocation. A later hardened version can use a device-generated asymmetric key pair whose private key never leaves the device.

### Account/person identity

The recipient should authenticate on a phone/browser, not by typing or speaking a reusable password to Nara.

Preferred account authentication order:

1. passkey/WebAuthn when available;
2. an established OAuth identity provider if desired;
3. email magic link/code as recovery/fallback;
4. a traditional password only if later product requirements justify it.

A display name or nickname can be spoken naturally during onboarding, but a name is profile data, not authentication.

### Device claim / proof of possession

On first boot, an unclaimed Nara should request a short-lived claim transaction and display:

- a QR code containing an opaque high-entropy claim URL/token;
- a short human-readable confirmation code under the QR;
- an expiry/progress indicator.

The recipient scans the QR, authenticates on their phone, and sees the same confirmation code. The server does not complete the claim until the recipient approves it.

For stronger proof of physical possession, require one local action on Nara, such as tapping/holding the screen or button during the claim.

The claim token must be one-time, short-lived, rate-limited, bound to one device, and invalid after success/reset/expiry.

RFC 8628 explicitly recommends still showing a human user code even when QR is used so the user can verify that the browser is authorizing the intended device.

### Viewer / speaker recognition

Voice recognition should happen after secure account/device claim.

Voice recognition answers **"who probably just spoke?"**, not **"who owns this device?"**.

It can be used for preferences, greetings, selecting likely memory namespaces, and low-risk personalization. It must not be the only protection for private memories, account/security changes, adding trusted users, exporting/deleting memory, credential rotation, or other high-impact actions.

If recognition is uncertain, use guest/least privilege or require phone/physical re-authentication.

## Recommended first-use experience

```text
Fresh Nara
   |
   | no Wi-Fi / unclaimed
   v
Provision network
   |
   v
Nara contacts bootstrap service
   |
   | receives short-lived claim transaction
   v
Display QR + short confirmation code
   |
   | recipient scans with phone
   v
Secure web onboarding
   |
   | sign in/create account
   | passkey preferred
   | confirm displayed code
   | confirm locally on Nara
   v
Backend binds account <-> device
   |
   | issue/rotate per-device credential
   v
Create recipient person profile
   |
   | preferred name / language / consent
   v
Optional voice enrollment
   |
   v
Personalized gift/welcome experience
```

## Spoken OTP/password assessment

A long OTP spoken aloud is not recommended as Nara's primary onboarding mechanism.

Reasons:

- anyone nearby or a recording can capture it;
- speech recognition can mishear characters and digits;
- users would need to repeat the most sensitive setup material aloud;
- long random strings are a poor voice interface;
- it mixes human authentication with physical-device pairing.

A short spoken PIN can make sense as a narrow confirmation mechanism. Amazon, for example, supports a four-digit spoken code for voice-purchase confirmation. That is not the same thing as using a spoken code as the root credential for claiming a device.

If Nara ever accepts a spoken setup code, it should be a short-lived secondary confirmation with other proof present, never a reusable password.

## Wi-Fi provisioning

Wi-Fi provisioning and account claiming are related but distinct.

Nara firmware already has first-boot Wi-Fi configuration, hotspot provisioning, optional ESP BLUFI, an activation state, NVS credential storage, and a runtime WebSocket token.

### Wi-Fi Easy Connect / DPP

ESP32-S3 supports Wi-Fi Easy Connect enrollee mode using a QR displayed on the device. On compatible Android phones, the phone can provision the ESP32-S3 to Wi-Fi without manually entering the Wi-Fi password into Nara.

Advantages: standardized, public-key-based, no Nara app required on supported phones, and a strong fit for the 360x360 display.

Platform support is not universal enough to make it Nara's only setup path.

### ESP-IDF Unified Provisioning

ESP-IDF supports SoftAP or BLE provisioning with authenticated/encrypted security schemes. Security 2 uses SRP6a plus AES-GCM and is Espressif's recommended production security version.

A practical Nara hierarchy should therefore remain transport-neutral:

- DPP QR when supported;
- secure BLE provisioning during a short setup window;
- secure SoftAP/captive setup as universal fallback.

Close the provisioning surface after success and require a deliberate local action/factory reset to reopen it.

## Gift-specific identity

A gift introduces two people that must not be conflated:

- **gift creator** — prepares/personalizes Nara and may supply knowledge intended to be shareable;
- **device recipient/admin** — receives the physical device and should normally administer that device.

The recipient can be the device administrator while having access only to personal memories explicitly shared with them.

Do not overload a memory label such as `person:owner` with device-ownership/security semantics.

Keep separate identifiers:

```text
account_id         -> authentication principal
person_id          -> human/profile in memory graph
device_id          -> physical Nara
device_role        -> admin / member / guest
relationship       -> partner / family / friend / ...
memory share rule  -> who may receive this specific fact
```

## Pre-personalized gift option

The creator can pre-register a device as a pending gift without creating or storing the recipient's password.

Example:

```text
device: nara_123
state: pending_gift
prepared_by: account_creator
intended_relationship: partner
recipient_account: unset
```

Private gift content can already be prepared with relationship-scoped sharing rules. When the actual recipient claims the device, their account/person ID is bound and the grants are resolved.

## Recovery, transfer, and theft

Onboarding must include lifecycle handling:

- recipient can remove/revoke a device;
- lost-device credentials can be revoked server-side;
- factory reset clears local claim/account credentials and returns to unclaimed state;
- old claim QR/codes cannot be reused;
- transferring the device requires explicit unlink/reset;
- human-account recovery happens on phone/browser, not through a universal device master password;
- backend tracks credential generation/rotation and rejects stale credentials.

## Threat model

| Threat | Design response |
|---|---|
| Setup QR photographed | short expiry + one-time token + account login + code comparison + physical confirmation |
| Package stolen before delivery | device remains unclaimed; no recipient password stored inside |
| Setup code replayed | fresh nonce, one-time use, expiry, rate limiting |
| One device credential leaks | per-device credential + revocation; no fleet-wide production token |
| Voice is imitated/replayed | voice match is convenience only; sensitive operations need stronger auth |
| Guest asks private questions | viewer/access filter runs before memory enters the model prompt |
| Device is sold/transferred | explicit unlink/factory reset + revoke old credential |
| Provisioning interface remains exposed | close setup window after success; deliberate local action to reopen |

## Nara-specific findings

Current firmware already provides useful primitives:

- no saved SSID -> Wi-Fi config mode;
- hotspot provisioning and optional ESP BLUFI;
- activation state and inherited activation-code/challenge machinery;
- NVS storage for WebSocket URL/token/version;
- eFuse serial-number handling and optional HMAC challenge support in inherited activation code;
- WebSocket bearer token sent to Nara Gateway.

Current server supports optional bearer authentication at `/device`, but currently uses one configured `NARA_DEVICE_TOKEN`. That is suitable for development and should evolve into a device registry with per-device credentials before multi-device production.

One cleanup found during review: Wi-Fi config still uses the inherited `Xiaozhi` SSID prefix. Rename it to Nara before shipping.

## Suggested implementation order

1. Define distinct account/person/device/relationship/role IDs.
2. Add a server-side device registry with unclaimed, claim-pending, active, and revoked states.
3. Add one-time claim transactions with high-entropy internal token, short human code, TTL and rate limiting.
4. Add a web claim flow and QR payload.
5. Add passkey registration/sign-in plus recovery fallback.
6. Replace production use of the global gateway token with per-device credential issuance/revocation.
7. Add local physical approval to final claim.
8. Connect claimed identity to viewer resolution and personal-memory access.
9. Add optional voice enrollment after secure claim works.
10. Add reset/unlink/transfer/credential-rotation tests.
11. Benchmark DPP and secure BLE/SoftAP provisioning on the real Waveshare board.
12. Polish the gift reveal dialogue/animation after the security flow is solid.

## Acceptance criteria

Onboarding is ready when tests prove:

- a fresh/unclaimed device cannot read private personal memory;
- claim tokens cannot be reused after success/expiry;
- a claim for device A cannot authorize device B;
- recipient account receives the intended device role;
- every device has a revocable credential;
- unknown speakers remain least privilege;
- voice matching cannot silently elevate security privilege;
- reset/revoke blocks old credentials;
- private memory remains filtered before prompt construction;
- no permanent human password is stored in firmware or the public repository.

## Research references

- Apple HomePod setup: https://support.apple.com/en-ie/111110
- Apple voice recognition / Personal Requests: https://support.apple.com/en-gb/108397
- Google smart speaker/display setup: https://support.google.com/googlehome/answer/7029485
- Google Voice Match: https://support.google.com/googlehome/answer/7320960
- Amazon Echo Spot setup: https://digprjsurvey.amazon.com/csad/help/node/TqUHXleMN3c6gh6Lmq
- OAuth Device Authorization Grant: https://www.rfc-editor.org/rfc/rfc8628.html
- Matter commissioning primer: https://developers.home.google.com/matter/primer/commissioning
- ESP-IDF Unified Provisioning: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/provisioning/provisioning.html
- ESP32-S3 Wi-Fi Easy Connect/DPP: https://docs.espressif.com/projects/esp-idf/en/v5.3.2/esp32s3/api-reference/network/esp_dpp.html
- NIST SP 1800-36: https://csrc.nist.gov/pubs/sp/1800/36/final
- FIDO passkeys: https://fidoalliance.org/passkeys/
- W3C WebAuthn Level 3: https://www.w3.org/TR/webauthn-3/
