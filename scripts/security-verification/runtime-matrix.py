from pathlib import Path
import subprocess, json, time, urllib.request, urllib.error, concurrent.futures, sys, os

folder = Path(os.environ.get("CHORUS_SECURITY_EVIDENCE_DIR", "/tmp/chorus-security-590-591-evidence"))
state = json.loads((folder / "runtime-private.json").read_text())
markers = json.loads((folder / "baseline-markers.json").read_text())
results = [r for r in json.loads((folder / "runtime-matrix.json").read_text()) if r.get("passed") and r["architecture"] == "amd64"] if "--arm64-only" in sys.argv else []

def command(args, log, timeout=120):
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    (folder / log).write_text(proc.stdout + "\n" + proc.stderr)
    if proc.returncode:
        raise RuntimeError(f"{log}: command exited {proc.returncode}")
    return proc.stdout.strip()

def request(base, route, data=None, cookie=None, timeout=60):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(base + route, headers=headers, data=json.dumps(data).encode() if data else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.load(response), response.headers.get("Set-Cookie", "").split(";")[0]
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), ""

def healthy(base, container, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            status, body, _ = request(base, "/api/health", timeout=3)
            if status == 200:
                return body
        except Exception:
            pass
        if subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container], capture_output=True, text=True).stdout.strip() == "false":
            raise RuntimeError(container + " exited before health")
        time.sleep(1)
    raise RuntimeError(container + " health timed out")

def database_state(kind, database, container, marker):
    sql = '''SELECT json_build_object('migration_count',(SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'failed_count',(SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL),'company_count',(SELECT COUNT(*) FROM "Company"),'user_count',(SELECT COUNT(*) FROM "User"),'project_count',(SELECT COUNT(*) FROM "Project"))::text;'''
    if kind == "pg":
        text = command(["docker", "exec", state["pg_container"], "psql", "-U", "postgres", "-d", database, "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], container + "-db.log")
    else:
        code = """const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:'postgresql://postgres:postgres@localhost:5433/postgres?sslmode=disable'});await c.connect();const r=await c.query(process.argv[1]);console.log(r.rows[0].json_build_object);await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})"""
        text = command(["docker", "exec", container, "node", "-e", code, sql], container + "-db.log", timeout=60)
    data = json.loads(text)
    if data["migration_count"] != 45 or data["failed_count"] != 0:
        raise RuntimeError("Unexpected migration history: " + str(data))
    if marker and data["project_count"] < 1:
        raise RuntimeError("Baseline project lost")
    return data

for arch in (["arm64"] if "--arm64-only" in sys.argv else ["amd64", "arm64"]):
    for kind in ["pg", "pglite"]:
        for mode in ["fresh", "upgrade"]:
            label = f"{arch}-{kind}-{mode}"
            container = "chorus-security-patched-" + label
            port = 55460 + len(results)
            base = f"http://127.0.0.1:{port}"
            marker = markers.get(f"{kind}-{arch}") if mode == "upgrade" else None
            result = {"architecture": arch, "database_mode": kind, "data_mode": mode, "container": container, "port": port, "arm64_execution": "QEMU emulation" if arch == "arm64" else None}
            results.append(result)
            args = ["docker", "run", "-d", "--platform", f"linux/{arch}", "--name", container, "--network", state["network"], "-p", f"127.0.0.1:{port}:8637"]
            env = {"NEXTAUTH_SECRET": state["nextauth_secret"], "DEFAULT_USER": state["default_user"], "DEFAULT_PASSWORD": state["default_password"], "COOKIE_SECURE": "false", "NEXT_TELEMETRY_DISABLED": "1"}
            database = f"security_pg_{arch}_{mode}"
            if kind == "pg":
                env.update({"DB_HOST": "chorus-security-pg", "DB_PORT": "5432", "DB_NAME": database, "DB_USERNAME": "postgres", "DB_PASSWORD": state["pg_password"]})
            else:
                args += ["-v", f"chorus-security-pglite-{arch}-{mode}:/app/data"]
            envfile = folder / (label + ".env")
            envfile.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
            envfile.chmod(0o600)
            args += ["--env-file", str(envfile), f"chorus-security:patched-{arch}"]
            try:
                command(args, label + "-launch.log")
                result["health"] = healthy(base, container)
                command(["docker", "logs", container], label + "-initial-startup.log")
                status, _, _ = request(base, "/api/projects")
                assert status == 401, ("Unauthenticated projects", status)
                status, body, cookie = request(base, "/api/auth/default-login", {"email": state["default_user"], "password": state["default_password"]})
                assert status == 200 and body["success"] and cookie.startswith("user_session="), ("Login", status, body)
                user = body["data"]["user"]
                result["user_uuid"] = user["uuid"]
                status, projects, _ = request(base, "/api/projects", cookie=cookie)
                assert status == 200 and projects["success"], ("Projects", status, projects)
                result["projects_before_restart"] = projects["data"]
                if marker:
                    assert user["companyUuid"] == marker["company"]
                    assert any(p["uuid"] == marker["project"] for p in projects["data"])
                # Exercise the route's concurrent count/list and connection reuse.
                def projects_request(_):
                    code, data, _ = request(base, "/api/projects", cookie=cookie)
                    if code != 200 or not data["success"]:
                        raise RuntimeError("Concurrent project query failed: " + str((code, data)))
                    return code
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    result["concurrent_project_statuses"] = list(pool.map(projects_request, range(12)))
                result["database_before_restart"] = database_state(kind, database, container, marker)
                if kind == "pg":
                    text = command(["docker", "exec", state["pg_container"], "psql", "-U", "postgres", "-d", database, "-tA", "-c", "SELECT bool_and(s.ssl) FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.datname=current_database() AND a.client_addr IS NOT NULL;"], label + "-tls.log")
                    assert text == "t", "Remote application connection is not TLS"
                    result["external_connections_tls"] = True
                command(["docker", "restart", container], label + "-restart.log")
                healthy(base, container)
                status, body, _ = request(base, "/api/auth/default-login", {"email": state["default_user"], "password": state["default_password"]})
                assert status == 200 and body["data"]["user"]["uuid"] == result["user_uuid"]
                status, projects_after, _ = request(base, "/api/projects", cookie=cookie)
                assert status == 200 and projects_after["data"] == result["projects_before_restart"]
                result["database_after_restart"] = database_state(kind, database, container, marker)
                assert result["database_before_restart"] == result["database_after_restart"]
                logs = command(["docker", "logs", container], label + "-all-startup.log")
                assert "No pending migrations to apply." in logs
                result["passed"] = True
                print(label, "PASS", flush=True)
            except Exception as error:
                result["passed"] = False
                result["failure"] = str(error)
                subprocess.run(["docker", "logs", container], stdout=(folder / (label + "-failure.log")).open("w"), stderr=subprocess.STDOUT)
                (folder / "runtime-matrix.json").write_text(json.dumps(results, indent=2))
                print(label, "FAIL", str(error), flush=True)
                raise
            finally:
                (folder / "runtime-matrix.json").write_text(json.dumps(results, indent=2))
            # Keep two native upgraded containers for the real browser checks.
            if not (arch == "amd64" and mode == "upgrade"):
                command(["docker", "stop", container], label + "-stop.log")

print("All eight startup/upgrade/restart combinations passed.", flush=True)
