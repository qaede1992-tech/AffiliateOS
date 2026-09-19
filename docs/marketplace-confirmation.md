# Marketplace activation confirmation

Marketplace connections are created inactive. AffiliateOS must not activate a marketplace connection merely because connection credentials or configuration are present.

The activation flow is intentionally two-step:

1. Create the marketplace connection with `enabled: false`.
2. Test/verify the connection.
3. Present an explicit confirmation prompt to the user before activation.
4. Only after the user's confirmation, call the enable endpoint with `enabled: true` and `confirmation: "CONFIRM_MARKETPLACE_CONNECTION"`.

Disabling a connection does not require confirmation.

This application-level confirmation is a required UX/API contract. A production deployment must also authenticate the operator performing the confirmation so the system can establish which authorized user approved the activation.
