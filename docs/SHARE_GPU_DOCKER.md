# Shared GPU (NVIDIA MIG) and Container Runtime

NVIDIA Multi-Instance GPU (MIG) splits one data-center GPU (H100, A100, A30) into up to 7 isolated slices, each with its own compute and memory. OPCP-explorer lets an administrator enable MIG on a registered server, list the GPU's MIG profiles, create instances and destroy them, from the web UI or the REST API. This raises GPU utilisation and isolates tenants at the hardware level.

Related docs: [SERVERLESS.md](SERVERLESS.md) · [INIT_PLATFORM.md](INIT_PLATFORM.md) · [API_REFERENCE.md](API_REFERENCE.md) · [technicals/ORCHESTRATOR.md](technicals/ORCHESTRATOR.md)

```
┌─────────────────────────────────────────────┐
│           NVIDIA H100 (80 GB)               │
├─────────┬─────────┬─────────┬───────────────┤
│ 1g.10gb │ 1g.10gb │ 2g.20gb │   3g.40gb     │
└─────────┴─────────┴─────────┴───────────────┘
   each slice addressable as  --gpus "device=MIG-<uuid>"
```

---

## How it works

All MIG actions are executed on the target server over SSH by the Flask app (`src/routes/gpu_routes.py`):

```
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@<server_ip> '<command>'
```

The server IP comes from `servers.server_ip`. The controller therefore needs key-based SSH access as `ubuntu` to each GPU server, and `ubuntu` needs passwordless `sudo` for `nvidia-smi`. Each SSH call times out after 30 s.

| Action | Command run on the server |
|--------|---------------------------|
| Enable shared GPU | `sudo nvidia-smi -mig 1` |
| List profiles | `nvidia-smi mig -lgip` |
| Create instances | `sudo nvidia-smi mig -cgi <id1>,<id2>,… -C` then `nvidia-smi -L` |
| Destroy all instances | `sudo nvidia-smi mig -dci` then `sudo nvidia-smi mig -dgi` |

Enabling MIG mode may require a GPU reset or reboot on some hardware; the platform does not do that.

---

## Web UI

- **Dashboard → Servers**: each server row has a **Shared-GPU** button that opens `/servers/<server_id>/gpu`.
- **`/servers/<server_id>/gpu`** (route `shared_gpu_page` in `src/routes/main_routes.py`, template `templates/shared_gpu.html`), admin only (`403 Forbidden` otherwise):
  1. **Toggle** shared GPU (`PUT …/gpu/enabled`); enabling loads the profiles.
  2. **Profiles table** (ID, name, memory MiB) with checkboxes; select 1–7 profiles and click create (`POST …/gpu/instances`).
  3. **Instances table** (UUID, profile, memory, created at), `GET …/gpu/instances`.
  4. **Destroy all** with a confirmation (`DELETE …/gpu/instances`).

---

## REST API

Blueprint `gpu_bp`, prefix `/api/servers/<int:server_id>/gpu`. Every endpoint requires a session (`401 Authentication required`) and admin rights read from `session['is_admin']` (`403 Admin access required`). Unknown server: `404 Server not found`.

### `PUT /api/servers/<id>/gpu/enabled`

Body: `{"enabled": true|false}` (boolean, else `400`).

- Updates `servers.shared_gpu_enabled`.
- When enabling, runs `sudo nvidia-smi -mig 1`; on failure, resets the flag to `false` and returns `500 {"error": "MIG mode could not be enabled: …"}`.
- Disabling only updates the flag (MIG mode and instances are left as they are).

Response `200`: `{"server_id": 3, "shared_gpu_enabled": true}`.

### `GET /api/servers/<id>/gpu/profiles`

Runs `nvidia-smi mig -lgip` and parses each profile row.

```json
{"profiles": [{"profile_id": 19, "name": "MIG 1g.10gb", "memory_mib": 9728}]}
```

`memory_mib` is the GiB value from `nvidia-smi` × 1024. SSH or `nvidia-smi` errors return `500` with the stderr text (prefixed `Server unreachable:` for timeouts / refused connections / no route).

### `POST /api/servers/<id>/gpu/instances`

Body: `{"profile_ids": ["19", "19", "14"]}`, 1–7 entries (`400` otherwise). Profile IDs are joined with commas, so send them as strings (the UI does).

- Requires `shared_gpu_enabled = true` (`400 Shared GPU must be enabled first`).
- Runs `sudo nvidia-smi mig -cgi <ids> -C`, then `nvidia-smi -L`; every `MIG <profile> Device N: (UUID: MIG-…)` line is inserted into `mig_instances` with `gpu_memory_mb = 0`.
- Response `201`: `{"message": "MIG instances created successfully", "instances": [{"instance_uuid": "MIG-…", "profile_name": "1g.10gb", "gpu_memory_mb": 0}]}`.
- Errors: creation failure → `500` with stderr (max 4096 chars); list failure → `500 {"error": "Instances created but detail retrieval failed", "output": …}`.

### `GET /api/servers/<id>/gpu/instances`

Returns the instances stored in `mig_instances` for the server (not queried live from the GPU), ordered by `created_at`:

```json
{"instances": [{"instance_uuid": "MIG-…", "profile_name": "1g.10gb", "gpu_memory_mb": 0, "created_at": "…"}]}
```

### `DELETE /api/servers/<id>/gpu/instances`

- `400 No MIG instances configured on this server` if `mig_instances` has no row for the server.
- Runs `sudo nvidia-smi mig -dci` then `sudo nvidia-smi mig -dgi`. DB rows are deleted only if both succeed; if `-dgi` fails after `-dci` the response says the state is inconsistent (`500`).
- Response `200`: `{"message": "All MIG instances destroyed", "count": 3}`.

There is no `GET …/gpu/enabled`; the page's initial toggle state relies on it, so the toggle shows "disabled" on load until changed.

Logs: `logs/gpu_routes.log`.

### Known issues in the current code

- `admin`-only checks read `session['is_admin']`, which the login flow does not set. Until that is fixed, the page and API answer `403` even for admins.
- Instance persistence conflicts with the schema: rows are inserted with `gpu_memory_mb = 0` (the column requires 1–81920), and the 40-character `MIG-<uuid>` does not fit `VARCHAR(36)`. After `nvidia-smi` succeeds, the `INSERT` can fail, so the slices exist on the GPU without being recorded.
- `nvidia-smi -L` lists all MIG devices, not only the new ones. Pre-existing instances are inserted again and hit the unique constraint.
- `GET …/instances` calls `execute_query` without `fetch_all=True`, so it receives a row count instead of rows and fails as soon as one instance is stored.

---

## Database (`migration/add_mig_gpu.sql`)

Applied automatically during DB init (`src/database_postgres.py`).

| Object | Columns |
|--------|---------|
| `servers.shared_gpu_enabled` | `BOOLEAN DEFAULT FALSE` |
| `mig_instances` | `server_id` (cascade), `instance_uuid VARCHAR(36)`, `profile_name`, `gpu_memory_mb` (`CHECK 1–81920`), `created_at`; unique `(server_id, instance_uuid)` |
| `mig_profiles` | `server_id`, `profile_name`, `profile_id`, `gpu_memory_gb` (1–80); created but not used by the code (profiles are always read live) |

---

## Using a MIG slice in a container

Once an instance exists, any container on that server can be pinned to it by UUID (requires the NVIDIA Container Toolkit):

```bash
nvidia-smi -L                                   # find MIG-<uuid>
docker run --rm --gpus '"device=MIG-<uuid>"' nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi
```

The platform does **not** attach MIG slices automatically. No launch path adds `--gpus`: not serverless jobs (`src/serverless/container_runtime.py`), not orchestrator replicas (`src/orchestrator.py`), and not template deployments. Assigning a slice to a workload is a manual step (for example in the application's own `docker-compose` / deploy script).

---

## Container runtime (runc / kata)

The runtime used for platform-launched containers is the top-level `runtime_type` key of the `configuration` table (seeded as `runc`). Admins set it in **Dashboard → Settings → Container Runtime Type**. Values are checked against an allow-list (`runc`, `kata`); anything else falls back to `runc`.

| Runtime | Isolation | Effect |
|---------|-----------|--------|
| `runc` (default) | Shared host kernel | No `--runtime` flag (Docker default) |
| `kata` | One lightweight MicroVM per container | Adds `--runtime kata` |

Where it applies:

- **Orchestrator replicas** (`src/orchestrator.py`, also used by template deployments): read on each container start.
- **Git-based app deployments** (`src/routes/api_routes.py`): passed to the deploy script as a trailing positional argument and as the `RUNTIME_TYPE` environment variable.
- **Serverless worker**: read once at worker startup; restart the worker after changing it.

GPU passthrough under Kata needs extra host configuration (VFIO / Kata GPU support) that the platform does not set up; use `runc` for GPU containers unless you have configured it.

---

## Host prerequisites (`init_pltf.sh`)

`init_pltf.sh` prepares the host it runs on:

1. **Kata Containers 3.32.0**: downloads `kata-static-3.32.0-amd64.tar.zst`, installs to `/opt/kata`, and **overwrites** `/etc/docker/daemon.json` with:
   ```json
   {"runtimes": {"kata": {"runtimeType": "/opt/kata/bin/containerd-shim-kata-v2"}}}
   ```
   then `systemctl reload docker`. Verify with `docker info | grep -i kata` and `docker run --runtime kata --rm hello-world`.
2. **NVIDIA driver**: `apt install nvidia-driver-550 nvidia-utils-550`. If that fails (no GPU), the GPU steps are skipped with a warning.
3. **MIG mode**: `sudo nvidia-smi -mig 1` (warning if the GPU does not support MIG).
4. **NVIDIA Container Toolkit**: `apt install nvidia-container-toolkit`, then a check with `docker run --rm --gpus '"device=0"' nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`.

The script does not run `nvidia-ctk runtime configure`. If the GPU check fails, configure the NVIDIA runtime in Docker manually, and merge its settings with the `kata` entry because `daemon.json` is overwritten.

Other GPU servers managed through `/servers/<id>/gpu` need the same driver, MIG and toolkit setup, plus SSH access for `ubuntu` from the controller.
