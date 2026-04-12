# MRStashDeviceAuth

A Stash plugin that lets VR headsets (Meta Quest, etc.) authenticate against
your Stash library without ever receiving your raw API key. It pairs devices
with a short-lived numeric code and then issues UUID device tokens used to
proxy both GraphQL metadata and video streams.

---

## Architecture

```
VR Headset (Quest)             Raspberry Pi (Docker / OMV)
──────────────────             ───────────────────────────
Unity VideoPlayer.url  ──────▶  :9997/stream/<id>?token=<t>  ┐
Unity HttpClient       ──────▶  :9997/graphql                 ├─ Sidecar (Flask)
Pairing UI             ──────▶  :9997/pair                    ┘
                                        │ injects real ApiKey
                                        ▼
                                :9999/graphql  (Stash)
                                :9999/scene/<id>/stream
```

- Port **9999** — Stash itself (never exposed to headset directly)
- Port **9997** — MRStashDeviceAuth sidecar (headset talks to this)

---

## Install

### 1. SSH into your Pi and clone the repo into Stash's plugins folder

```bash
# Find your plugins folder (look for the volume mapped to /root/.stash)
docker inspect stash | grep -A2 Mounts

# Clone — adjust the path to match your volume mount
cd /your/appdata/stash/plugins
git clone https://github.com/mrtoadx/MRStashDeviceAuth
```

The folder must be named `MRStashDeviceAuth` and contain all three plugin files.

### 2. Install Python dependencies inside the container

```bash
docker exec stash pip3 install flask requests pyyaml --break-system-packages
```

> **Tip:** Add this to a startup script or a Docker entrypoint if you want it
> to survive container rebuilds. Alternatively pin the packages in a custom
> `Dockerfile` that extends `stashapp/stash`.

### 3. Expose port 9997 in your compose file

Add `- "9997:9997"` to the `ports:` section of your Stash service.
See `docker-compose.example.yml` for a complete example.

Restart the container:
```bash
docker compose up -d stash
```

### 4. Reload plugins in Stash

Settings → Plugins → **Reload plugins**

The **Device Auth** page will appear in the sidebar. Navigate to it — the
sidecar starts automatically.

---

## Update

```bash
cd /your/appdata/stash/plugins/MRStashDeviceAuth
git pull
```

Then in Stash: Settings → Plugins → **Reload plugins**.

If the sidecar is running it will keep serving until the next Stash restart or
until you trigger **Start Sidecar** manually, which replaces the old process.

---

## Pairing a device (Meta Quest)

1. From Unity, call `POST http://<pi-ip>:9997/pair`
   ```json
   { "device_name": "Quest 3" }
   ```
   Response: `{ "code": "483921", "expires_in": 300 }`

2. Open `http://<pi-ip>:9997` in a browser **or** navigate to Device Auth in
   Stash — click **Approve** next to the 6-digit code.

3. The API returns a UUID device token:
   ```json
   { "token": "f47ac10b-58cc-...", "device_name": "Quest 3" }
   ```
   Store this token on the headset (PlayerPrefs, etc.).

---

## Unity 6 Integration

### GraphQL metadata
```csharp
var request = new HttpRequestMessage(HttpMethod.Post,
    $"http://{piHost}:9997/graphql");
request.Headers.Authorization =
    new AuthenticationHeaderValue("Bearer", deviceToken);
request.Content = new StringContent(
    JsonConvert.SerializeObject(new { query = "{ findScenes { scenes { id title } } }" }),
    Encoding.UTF8, "application/json");
var response = await httpClient.SendAsync(request);
```

### Video stream (VideoPlayer)
```csharp
// Token goes in the query string — VideoPlayer cannot set custom headers
// on the underlying native stream request.
videoPlayer.url = $"http://{piHost}:9997/stream/{sceneId}?token={deviceToken}";
videoPlayer.Play();
```

**Why query string for the stream?**
Unity 6's `VideoPlayer` hands the URL directly to Android's ExoPlayer for
hardware-accelerated decoding. There is no API surface to inject headers
before ExoPlayer opens the connection. The sidecar accepts the token as
`?token=` on `/stream/*` (and as `Authorization: Bearer` on `/graphql`).

**Seek / scrub support:**
ExoPlayer automatically issues HTTP `Range` requests when the user seeks.
The sidecar forwards `Range` headers and mirrors `206 Partial Content`
responses from Stash, so scrubbing works out of the box.

**Supported formats:**
Unity 6 VideoPlayer on Android (Quest) supports H.264/H.265 MP4, MKV, and
WebM. Stash streams the original file — if Stash's transcoder is enabled,
it will also transcode on the fly. HLS/m3u8 is **not** supported by Unity's
built-in VideoPlayer without a third-party plugin (AVPro Video, HISPlayer).

---

## Sidecar endpoints quick reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Liveness check |
| POST | `/pair` | none | Request pairing code |
| POST | `/pair/approve` | none (localhost UI) | Approve a code |
| POST | `/pair/deny` | none (localhost UI) | Deny a code |
| GET | `/pending` | none | List pending codes |
| GET | `/devices` | none | List paired devices |
| POST | `/revoke` | none | Revoke a device token |
| POST | `/graphql` | Bearer token | Authenticated GraphQL proxy |
| GET | `/stream/<id>` | ?token= | Authenticated stream proxy |
| GET | `/` | none | Approval / management UI |

---

## Troubleshooting

**Sidecar won't start**
```bash
docker exec -it stash python3 /root/.stash/plugins/MRStashDeviceAuth/MRStashDeviceAuth_sidecar.py
```
Watch for import errors — usually a missing pip package.

**Port 9997 refused from headset**
- Confirm `- "9997:9997"` is in your compose `ports:`.
- Confirm the Pi's firewall allows TCP 9997 (`ufw allow 9997` if using ufw).
- Check the sidecar is actually running: `curl http://localhost:9997/health` from the Pi.

**"Scene not found" on /stream**
The sidecar queries Stash's GraphQL to resolve the stream URL. Make sure the
`server_connection` port in Stash's stdin JSON matches actual Stash port (9999).
Run the "Start Sidecar" task manually and check Docker logs:
```bash
docker logs stash --tail 50
```

**pairing.json location**
Written next to `MRStashDeviceAuth_sidecar.py` inside the container, which is
`/root/.stash/plugins/MRStashDeviceAuth/pairing.json` on the host volume — it
survives container restarts automatically.
