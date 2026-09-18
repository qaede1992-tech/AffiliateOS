# Social OAuth integration boundary

AffiliateOS keeps OAuth orchestration provider-neutral. The API owns short-lived, one-time state and never stores OAuth access tokens directly in social-account API views.

An approved provider adapter must implement `SocialOAuthProvider` and return an opaque `credentialReference` backed by deployment secret management. The adapter is responsible for the platform's official authorization URL, scopes, redirect requirements, and authorization-code exchange.

No production social provider is registered by default. The current workflow therefore exposes the connection contract without claiming that any external platform is connected.
