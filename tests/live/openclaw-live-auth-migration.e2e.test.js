// LIVE TIER — the legacy auth-store migration contract, probed against the
// REAL pinned build's `doctor --fix --yes`:
//   A credential-bearing legacy agents/<id>/agent/auth-profiles.json (the
//   shape a post-onboarding Codex OAuth connect leaves behind) must force a
//   guarded doctor run at boot even when the config migration is already
//   complete, that doctor must move auth into the shared state-db store, and
//   the credential MATERIAL (access/refresh/expires) must survive the move.
//   Otherwise every agent run fails with AUTH_PROFILE_MIGRATION_REQUIRED —
//   or worse, silently loses the user's OAuth session (the fresh-install fix
//   this line carries in reconcileBootConfig).
// The hermetic suite mocks doctor, so it cannot see upstream drift in what
// doctor --fix actually does with a legacy store — only this tier runs the
// real binary. When this file fails but the hermetic suite is green, suspect
// upstream OpenClaw drift first (AGENTS.md "test:live" note).

const fs = require("fs");
const path = require("path");
// live-helpers only touches fs/os/path — safe to load BEFORE the env below.
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-auth-migration-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const {
  createOpenclawChannelSync,
  readDeclaredPin,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { kLiveEnabled, kSilentLogger, mkTemp } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 12 * 60 * 1000;

// The pinned CLI enforces its Node engines at runtime; the reconciler spawns
// doctor with process.execPath, so the vitest process itself must satisfy the
// pin's floor (2026.9.x: >=24.16 <25 || >=26.1). CI's setup-node does; an old
// local runtime fails HERE with the cause named, not on a doctor timeout.
const kNodeSatisfiesPin = (() => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
})();

// The Codex OAuth profile shape a post-onboarding connect writes into the
// legacy store, with SENTINEL credential material (the runtime's persisted
// OAuth fields are access/refresh/expires — see AuthProfileCredential in the
// packaged types). The postconditions below assert these exact values survive
// the migration; a doctor that drains the file without copying credentials
// fails here.
const kSentinelCredentials = {
  access: "SENTINEL-ACCESS-TOKEN",
  refresh: "SENTINEL-REFRESH-TOKEN",
  expires: 4102444800000,
};
const kCodexProfile = {
  "openai:codex-cli": {
    type: "oauth",
    provider: "openai",
    ...kSentinelCredentials,
  },
};

const legacyAuthStorePath = (openclawDir) =>
  path.join(openclawDir, "agents", "main", "agent", "auth-profiles.json");

// The lib's own predicate semantics: a legacy store owns credentials while
// the file exists with at least one profile entry.
const legacyStoreOwnsCredentials = (openclawDir) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyAuthStorePath(openclawDir), "utf8"));
    return Object.keys(parsed?.profiles || {}).length > 0;
  } catch {
    return false;
  }
};

const openStateDb = (openclawDir) => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(openclawDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath);
};

const readSharedStoreLocation = (openclawDir) => {
  const db = openStateDb(openclawDir);
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'")
      .get();
    return row ? JSON.parse(row.value_json)?.location || null : null;
  } finally {
    db.close();
  }
};

// The migrated shared auth store lives in config_machine_state under
// authProfiles.store (verified against real 2026.9.5 doctor output). The
// migration ALIASES the legacy profile id (observed: openai:codex-cli ->
// openai:default via the auth-profile-sqlite-alias-map migration), so match
// on the credential material and provider, never on the legacy key.
const readMigratedProfiles = (openclawDir) => {
  const db = openStateDb(openclawDir);
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'")
      .get();
    return row ? JSON.parse(row.value_json)?.profiles || null : null;
  } finally {
    db.close();
  }
};

describeLive(
  "LIVE legacy auth-store migration at boot (real doctor)",
  { retry: 1 },
  () => {
    it(
      "a credential-bearing legacy store forces a real doctor --fix that migrates auth WITH its credentials to the shared store; the next boot is a no-op",
      { timeout: kTestTimeoutMs },
      async () => {
        expect(
          kNodeSatisfiesPin,
          `live auth-migration tier needs a Node the pinned runtime supports (>=24.16 <25 || >=26.1); this process is ${process.versions.node}`,
        ).toBe(true);

        const pin = readDeclaredPin();
        expect(pin).toBeTruthy();
        // Exact-version immutable cache shared with the other live tiers —
        // no fresh npm install per run (or per retry) when the pin is warm.
        const staged = await liveHelpers.stageOpenclawVersion(pin, {
          logger: kSilentLogger,
        });
        const installDir = path.dirname(path.dirname(staged.packageDir));

        const rootDir = mkTemp("alphaclaw-live-auth-migration-e2e-");
        const openclawDir = path.join(rootDir, ".openclaw");
        fs.mkdirSync(path.dirname(legacyAuthStorePath(openclawDir)), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(openclawDir, "openclaw.json"),
          `${JSON.stringify({ gateway: {} }, null, 2)}\n`,
        );
        fs.writeFileSync(
          legacyAuthStorePath(openclawDir),
          JSON.stringify({ version: 1, profiles: kCodexProfile }),
        );

        const store = createOpenclawReleaseChannelStore({
          rootDir,
          openclawDir,
          logger: kSilentLogger,
        });
        store.writeSentinel({ installDir, version: pin });
        // Fresh-install shape: the config migration already completed for
        // this pin, and only THEN did the Codex OAuth connect leave a
        // credential-bearing legacy store behind.
        store.updateState((s) => {
          s.pinVersion = pin;
          s.configMigration = {
            completedForVersion: pin,
            lastAttempt: { version: pin, at: 1, ok: true },
          };
          return s;
        });

        const realRunner = createRunStream({});
        let doctorCalls = 0;
        const countingRunner = {
          ...realRunner,
          runStreamed: (opts) => {
            if (Array.isArray(opts?.args) && opts.args[1] === "doctor") {
              doctorCalls += 1;
            }
            return realRunner.runStreamed(opts);
          },
        };

        const sync = createOpenclawChannelSync({
          rootDir,
          openclawDir,
          packageRoot: installDir,
          store,
          runStream: countingRunner,
          resolveInstallDir: () => installDir,
          // The installed CLI resolves its state dir from
          // OPENCLAW_STATE_DIR (production sets it; without it doctor
          // migrates the ambient ~/.openclaw and the boot holds
          // fail-closed). Scrub the vitest marker vars so the child runs
          // like a normal CLI invocation (its stdout is suppressed when
          // VITEST is inherited).
          openclawSpawnEnv: () => ({
            ...liveHelpers.scrubTestRunnerEnv(),
            OPENCLAW_STATE_DIR: openclawDir,
          }),
          readReleaseChannel: () => "stable",
          isOnboarded: () => true,
          restartProcess: () => {},
          clearVersionCache: () => {},
          notify: async () => {},
          logger: kSilentLogger,
          backupsDir: path.join(rootDir, "backups", "openclaw"),
        });

        const first = await sync.reconcileBootConfig();
        expect(
          first.status,
          `boot with a credential-bearing legacy store must converge (got ${first.status}: ${first.hold?.reason || first.reason || "no reason"}) — if this regresses upstream, agent runs fail with AUTH_PROFILE_MIGRATION_REQUIRED`,
        ).toBe("ok");
        expect(doctorCalls).toBe(1);
        expect(
          legacyStoreOwnsCredentials(openclawDir),
          "the real doctor --fix must drain the legacy auth store",
        ).toBe(false);
        expect(
          readSharedStoreLocation(openclawDir),
          "the real doctor --fix must flip auth.sharedStore to the state db",
        ).toBe("state-db");

        // The point of the whole exercise: credential MATERIAL survives.
        const migrated = readMigratedProfiles(openclawDir);
        expect(
          migrated,
          "the real doctor --fix must populate the shared auth store",
        ).toBeTruthy();
        const surviving = Object.values(migrated).find(
          (profile) =>
            profile?.type === "oauth" &&
            profile?.provider === "openai" &&
            profile?.access === kSentinelCredentials.access &&
            profile?.refresh === kSentinelCredentials.refresh &&
            profile?.expires === kSentinelCredentials.expires,
        );
        expect(
          surviving,
          `the migrated shared store must retain the OAuth credential material (access/refresh/expires) — got profiles: ${JSON.stringify(migrated)}`,
        ).toBeTruthy();

        // Next boot: shared-store flag owns auth, so the fast path applies
        // and the sized doctor budget is NOT spent again.
        const second = await sync.reconcileBootConfig();
        expect(second).toEqual(
          expect.objectContaining({ status: "ok", reason: "already-completed" }),
        );
        expect(doctorCalls).toBe(1);
      },
    );
  },
);
