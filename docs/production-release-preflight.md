# Production release preflight

Run immediately before starting a production API process:

```bash
NODE_ENV=production npm run production:preflight
```

The check validates configuration shape only. It never prints credential values and does not contact marketplace, social, or AI providers.

Required production settings:

- `DATABASE_URL`: PostgreSQL connection URL.
- `API_AUTH_TOKEN`: bearer/session secret of at least 32 characters.
- `API_CORS_ORIGIN`: HTTPS dashboard origin.

When `AUTONOMOUS_CYCLE_ENABLED=true`, the autonomous cycle interval must remain at least five minutes.

Provider credentials remain secret-manager references and are intentionally outside this preflight.
