# Test data homes

`vitest.config.ts` creates a disposable run root. Its setup file allocates a new
data home for every test file before application imports capture paths. This
also separates files assigned to a reused worker. Tests may still override
their own paths. The config process removes the complete run root on exit.

Keep the run-level environment defaults: they are a safety floor before setup
runs. Do not redirect `COS_SCRIPTS_DIR` to a fake bridge or a live profile.

The normal suite remains serial by default. To check concurrency explicitly,
run this command through the machine's release-lane guard with weight 2:

```sh
./node_modules/.bin/vitest run --config test-support/isolation-canary/vitest.config.ts
```

The two files exchange readiness markers outside their data homes, then assert
that concurrent writes cannot change the other file's fingerprint. The canary
is outside the normal test include because it needs exactly two workers.
Bypassing `setup-data-home.ts` must fail its directory-content assertion; this
checks that a green result depends on actual filesystem isolation.
