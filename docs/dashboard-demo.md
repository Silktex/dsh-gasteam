# Workspace dashboard demo

The dashboard demo starts the shipped Web profile, client bundle, typed Remote
gateway, Team service, and `WorkspaceCoordinator` against an isolated home. Its
only model adapter is a deterministic in-process fixture. It does not read a
provider credential or make a paid model request.

From a built checkout, run:

```sh
TMPDIR=/var/tmp pnpm demo:dashboard -- --port 49180
```

The launcher builds the packages, creates a disposable Git repository and
`DSH_HOME` under `/var/tmp`, installs the Web profile there, and prints both the
data directory and a private local URL. Treat the URL as a bearer credential:
open it locally and do not paste it into logs, screenshots, or bug reports. To
reuse an existing isolated directory after a successful build, pass
`--directory /var/tmp/my-dashboard-demo --skip-build`.

Open **GasTeam dashboard demo**, select **Workspace dashboard
controlled-provider**, and activate **Agent Team**. The overview is backed by
the coordinator's durable assignment store. It contains 130 completed attempts
so the summary is bounded and history spans three 64-item pages. The attempts
repeat three provider-reporting cases:

- `Usage unknown · Cost unknown` when the provider supplied no usage;
- `Input: 0` and `Output: 0` when the provider explicitly reported zero;
- positive input, cached-input, output, and reasoning-output counts.

To replay keyboard paging, focus **Collection**, press Arrow Down to select
**Attempts**, focus **Next**, and press Enter. The first retained row changes
from `attempt-1` to `attempt-299`. Focus **Previous** and press Enter to return
to `attempt-1`.

Select **Unauthorized dashboard observer demonstr** while the Agent Team view
is open. The same typed Remote must show `Caller is not the configured
workspace operator`; selecting the controlled-provider session restores the
dashboard. This proves that changing the browser session does not inherit the
Lead's coordinator authority.

Stop the process with Ctrl-C. The printed data directory is disposable and can
be removed after the process exits.
