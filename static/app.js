/* =============================================================================
   Aura — browser client
   Transcripts come from exactly one place: the "aura" data-channel topic
   published by agent.py. Mixing that with LiveKit's own transcription events
   is what produced duplicate bubbles before, so those handlers stay off.
   ========================================================================== */

const { Room, RoomEvent, Track } = LivekitClient;

const el = {
    statusPill:   document.getElementById('statusPill'),
    statusLabel:  document.getElementById('statusLabel'),
    micBtn:       document.getElementById('micBtn'),
    headline:     document.getElementById('headline'),
    subline:      document.getElementById('subline'),
    latencyChip:  document.getElementById('latencyChip'),
    latencyValue: document.getElementById('latencyValue'),
    engineChip:   document.getElementById('engineChip'),
    engineValue:  document.getElementById('engineValue'),
    chatScroll:   document.getElementById('chatScroll'),
    chatEmpty:    document.getElementById('chatEmpty'),
    clearBtn:     document.getElementById('clearBtn'),
    typingRow:    document.getElementById('typingRow'),
    typingText:   document.getElementById('typingText'),
    toast:        document.getElementById('toast'),
    orb:          document.getElementById('orb'),
    cursorGlow:   document.getElementById('cursorGlow'),
};

let room = null;
let connecting = false;

// Audio analysis
let audioCtx = null;
let micAnalyser = null;
let auraAnalyser = null;
const audioNodes = [];

// Rendered messages, keyed by the id the agent sends
const bubbles = new Map();

let toastTimer = null;

/* -------------------------------------------------------------------------- */
/* Status + copy                                                              */
/* -------------------------------------------------------------------------- */

function setStatus(state, label) {
    el.statusPill.dataset.state = state;
    el.statusLabel.textContent = label;
}

function setCopy(headline, subline) {
    el.headline.textContent = headline;
    if (subline !== undefined) el.subline.textContent = subline;
}

function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
}

function setTyping(visible, label) {
    el.typingRow.hidden = !visible;
    if (label) el.typingText.textContent = label;
}

function setLatency(ms) {
    if (ms == null) {
        el.latencyChip.hidden = true;
        return;
    }
    el.latencyChip.hidden = false;
    el.latencyValue.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
    el.latencyValue.className = 'chip-val ' + (ms < 1500 ? 'fast' : ms > 3500 ? 'slow' : '');
}

/* -------------------------------------------------------------------------- */
/* Conversation rendering                                                     */
/* -------------------------------------------------------------------------- */

function timeNow() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isPinnedToBottom() {
    const { scrollTop, scrollHeight, clientHeight } = el.chatScroll;
    return scrollHeight - scrollTop - clientHeight < 90;
}

function renderMessage({ id, role, text, interim = false }) {
    const body = (text || '').trim();
    if (!body) return;

    if (el.chatEmpty) {
        el.chatEmpty.remove();
        el.chatEmpty = null;
    }

    const stick = isPinnedToBottom();
    let node = bubbles.get(id);

    if (!node) {
        node = document.createElement('article');
        node.className = `msg ${role}`;

        const head = document.createElement('header');
        head.className = 'msg-head';

        const who = document.createElement('span');
        who.className = 'msg-who';
        who.textContent = role === 'user' ? 'You' : role === 'agent' ? 'Aura' : 'System';

        const when = document.createElement('span');
        when.className = 'msg-time';
        when.textContent = timeNow();

        head.append(who, when);

        const para = document.createElement('p');
        para.className = 'msg-body';

        node.append(head, para);
        el.chatScroll.appendChild(node);
        bubbles.set(id, node);
    }

    node.classList.toggle('interim', interim);
    node.querySelector('.msg-body').textContent = body;

    if (stick) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
}

function clearConversation() {
    bubbles.clear();
    el.chatScroll.innerHTML = '';

    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML =
        '<div class="empty-glyph"></div>' +
        '<p>Everything you say and everything Aura says will appear here.</p>';
    el.chatScroll.appendChild(empty);
    el.chatEmpty = empty;

    setTyping(false);
    setLatency(null);
}

/* -------------------------------------------------------------------------- */
/* Agent events                                                               */
/* -------------------------------------------------------------------------- */

function handleAgentEvent(data) {
    switch (data.type) {
        case 'ready':
            if (data.llm) {
                el.engineChip.hidden = false;
                el.engineValue.textContent = data.llm;
                if (/offline/i.test(data.llm)) {
                    showToast('No cloud language model is reachable, so Aura is using its limited offline brain. Check the API keys in your .env file.');
                }
            }
            setCopy('Aura is listening', 'Speak naturally — she replies when you pause.');
            break;

        case 'user_message':
            renderMessage({ id: data.id, role: 'user', text: data.text, interim: !data.final });
            if (data.final) setTyping(true, 'Aura is thinking…');
            break;

        case 'agent_message':
            setTyping(false);
            renderMessage({ id: data.id, role: 'agent', text: data.text });
            break;

        case 'agent_state':
            applyAgentState(data);
            break;

        case 'error':
            setTyping(false);
            renderMessage({ id: `err-${Date.now()}`, role: 'system', text: data.text });
            showToast(data.text);
            break;
    }
}

function applyAgentState(data) {
    switch (data.state) {
        case 'listening':
            setTyping(false);
            setCopy('Aura is listening', 'Speak naturally — she replies when you pause.');
            break;
        case 'thinking':
            setTyping(true, 'Aura is thinking…');
            setCopy('Thinking…', 'Working out the best answer for you.');
            break;
        case 'speaking':
            setTyping(false);
            setCopy('Aura is speaking', 'Jump in any time — she will stop and listen.');
            if (data.latency_ms != null) setLatency(data.latency_ms);
            break;
        case 'initializing':
            setCopy('Waking up…', 'Loading the speech models.');
            break;
    }
}

/* -------------------------------------------------------------------------- */
/* Audio analysis for the orb                                                 */
/* -------------------------------------------------------------------------- */

async function ensureAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
    return audioCtx;
}

function attachAnalyser(mediaStream, which) {
    if (!audioCtx || !mediaStream) return;
    try {
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;

        const source = audioCtx.createMediaStreamSource(mediaStream);
        source.connect(analyser);
        audioNodes.push(source);

        if (which === 'mic') micAnalyser = analyser;
        else auraAnalyser = analyser;
    } catch (err) {
        console.warn('Analyser setup failed:', err);
    }
}

function releaseAudio() {
    audioNodes.forEach((node) => {
        try { node.disconnect(); } catch (_) { /* already gone */ }
    });
    audioNodes.length = 0;
    micAnalyser = null;
    auraAnalyser = null;
}

function levelOf(analyser) {
    if (!analyser) return 0;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    return sum / bins.length;
}

/* -------------------------------------------------------------------------- */
/* Orb visualiser — a real 3D, noise-displaced orb driven by mic/agent audio. */
/* Falls back to a flat 2D pulse if WebGL is unavailable or motion is         */
/* reduced, so the hero is never blank.                                      */
/* -------------------------------------------------------------------------- */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function hasWebGL() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (_) {
        return false;
    }
}

function currentEnergy() {
    const aura = levelOf(auraAnalyser);
    const mic = levelOf(micAnalyser);
    const auraActive = aura > 4;
    const micActive = !auraActive && mic > 6;
    return { auraActive, micActive, level: auraActive ? aura : micActive ? mic : 0 };
}

function runFlatOrb() {
    const ctx = el.orb.getContext('2d');
    let orbW = 0;
    let orbH = 0;

    function sizeOrb() {
        const dpr = window.devicePixelRatio || 1;
        orbW = el.orb.clientWidth;
        orbH = el.orb.clientHeight;
        el.orb.width = Math.round(orbW * dpr);
        el.orb.height = Math.round(orbH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', sizeOrb);
    sizeOrb();

    let phase = 0;
    function frame() {
        requestAnimationFrame(frame);
        if (!orbW || !orbH) return;

        ctx.clearRect(0, 0, orbW, orbH);
        const cx = orbW / 2;
        const cy = orbH / 2;
        const base = Math.min(orbW, orbH) * 0.24;

        const { auraActive, micActive, level } = currentEnergy();
        phase += 0.022;

        const hue = auraActive ? 258 : micActive ? 187 : 232;
        const radius = base + level * 0.42;

        const glow = ctx.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius + 46);
        glow.addColorStop(0, `hsla(${hue}, 88%, 66%, ${level > 0 ? 0.26 : 0.12})`);
        glow.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 46, 0, Math.PI * 2);
        ctx.fill();

        for (let i = 0; i < 3; i++) {
            const wobble = level > 0
                ? Math.sin(phase * 2.1 + i * 1.4) * (level * (0.16 + i * 0.11))
                : Math.sin(phase + i * 0.85) * 3.2;
            const r = Math.max(8, base + 10 + i * 9 + wobble);
            const alpha = level > 0 ? 0.55 - i * 0.14 : 0.16 - i * 0.04;

            ctx.beginPath();
            ctx.lineWidth = 1.4 + i * 0.35;
            ctx.strokeStyle = `hsla(${hue}, 90%, 70%, ${alpha})`;
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    frame();
}

const ORB_VERT = `
uniform float uTime; uniform float uAmp;
varying float vN; varying vec3 vNorm; varying vec3 vPos;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))
        +i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
void main(){
  vec3 p = position;
  float n  = snoise(p*1.35 + uTime*0.22);
  float n2 = snoise(p*3.1  - uTime*0.35)*0.45;
  float d  = (n+n2) * (0.09 + uAmp*0.5);
  p += normal * d;
  vN=n; vNorm=normalize(normalMatrix*normal);
  vPos=(modelViewMatrix*vec4(p,1.0)).xyz;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;

const ORB_FRAG = `
uniform vec3 uA; uniform vec3 uB; uniform float uAmp;
varying float vN; varying vec3 vNorm; varying vec3 vPos;
void main(){
  vec3 v = normalize(-vPos);
  float fres = pow(1.0 - max(dot(v, normalize(vNorm)), 0.0), 2.6);
  vec3 col = mix(uA, uB, smoothstep(-0.55, 0.65, vN));
  col += fres * 0.85;
  col += uAmp * 0.28;
  gl_FragColor = vec4(col, 1.0);
}`;

async function runVoxelOrb() {
    let THREE;
    try {
        THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
    } catch (err) {
        console.warn('Three.js failed to load — falling back to the 2D orb.', err);
        runFlatOrb();
        return;
    }

    const mobile = matchMedia('(max-width: 940px)').matches;

    const renderer = new THREE.WebGLRenderer({ canvas: el.orb, alpha: true, antialias: !mobile });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3.4;

    const uni = {
        uTime: { value: 0 },
        uAmp: { value: 0 },
        uA: { value: new THREE.Color('#160f3a') },
        uB: { value: new THREE.Color('#9b8cf5') },
    };
    const COLOR_AGENT = '#9b8cf5'; // idle / Aura speaking
    const COLOR_USER = '#22d3ee';  // you speaking

    const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.05, mobile ? 3 : 5),
        new THREE.ShaderMaterial({ vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, uniforms: uni })
    );
    scene.add(mesh);

    const wire = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.38, 2),
        new THREE.MeshBasicMaterial({ color: 0x9b8cf5, wireframe: true, transparent: true, opacity: 0.12 })
    );
    scene.add(wire);

    const particleCount = mobile ? 90 : 220;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
        const r = 1.9 + Math.random() * 1.6;
        const t = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(ph) * Math.cos(t);
        positions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(t);
        positions[i * 3 + 2] = r * Math.cos(ph);
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.014, transparent: true, opacity: 0.4 })));

    function sizeOrb() {
        const w = el.orb.clientWidth;
        const h = el.orb.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
    }
    window.addEventListener('resize', sizeOrb);
    sizeOrb();

    let mx = 0, my = 0, px = 0, py = 0;
    window.addEventListener('pointermove', (e) => {
        mx = e.clientX / window.innerWidth - 0.5;
        my = e.clientY / window.innerHeight - 0.5;
    });

    let amp = 0;
    function loop() {
        requestAnimationFrame(loop);

        const t = performance.now() * 0.001;
        const { micActive, level } = currentEnergy();
        const target = Math.min((level / 255) * 2.2, 1);
        amp += (target - amp) * 0.14;

        uni.uTime.value = t;
        uni.uAmp.value = amp;
        uni.uB.value.lerp(new THREE.Color(micActive ? COLOR_USER : COLOR_AGENT), 0.04);

        px += (mx - px) * 0.05;
        py += (my - py) * 0.05;
        mesh.rotation.y = t * 0.12 + px * 0.5;
        mesh.rotation.x = py * 0.4;
        wire.rotation.y = -t * 0.08 + px * 0.3;
        wire.rotation.z = t * 0.05;
        mesh.scale.setScalar(1 + amp * 0.16);
        wire.scale.setScalar(1 + amp * 0.08);

        renderer.render(scene, camera);
    }
    loop();
}

if (reduceMotion || !hasWebGL()) {
    runFlatOrb();
} else {
    runVoxelOrb();
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function buildRoom() {
    const r = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Echo cancellation is what stops Aura from hearing her own voice
        // through your speakers and replying to herself.
        audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
        },
    });

    r.on(RoomEvent.Connected, () => {
        setStatus('live', 'Connected');
        setCopy('Waiting for Aura…', 'Connecting you to the assistant.');
    });

    r.on(RoomEvent.Disconnected, () => {
        teardown('Session ended.');
    });

    r.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic && topic !== 'aura') return;
        try {
            handleAgentEvent(JSON.parse(new TextDecoder().decode(payload)));
        } catch (err) {
            console.debug('Ignoring non-JSON data message', err);
        }
    });

    r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;

        // Never stack two <audio> elements on one track — that doubles the voice.
        document.querySelectorAll(`audio[data-sid="${track.sid}"]`).forEach((n) => n.remove());

        const audio = track.attach();
        audio.dataset.sid = track.sid;
        audio.autoplay = true;
        audio.dataset.aura = 'true';
        document.body.appendChild(audio);
        audio.play().catch(() => {
            showToast('Your browser blocked audio playback. Click anywhere on the page to enable sound.');
            const unlock = () => { audio.play().catch(() => {}); document.removeEventListener('click', unlock); };
            document.addEventListener('click', unlock);
        });

        if (track.mediaStream) attachAnalyser(track.mediaStream, 'aura');
    });

    r.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((node) => node.remove());
        auraAnalyser = null;
    });

    r.on(RoomEvent.ParticipantConnected, () => {
        setCopy('Aura is listening', 'Speak naturally — she replies when you pause.');
    });

    r.on(RoomEvent.ParticipantDisconnected, () => {
        setTyping(false);
        setCopy('Aura went away', 'The agent worker disconnected. Check the terminal running main.py.');
    });

    // Compare as strings so a newer CDN build of the SDK cannot break this.
    r.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === 'reconnecting') setStatus('connecting', 'Reconnecting');
        else if (state === 'connected') setStatus('live', 'Connected');
    });

    return r;
}

async function connect() {
    if (connecting || room) return;
    connecting = true;

    el.micBtn.disabled = true;
    setStatus('connecting', 'Connecting');
    setCopy('Connecting…', 'Setting up a secure realtime audio channel.');

    try {
        await ensureAudioContext();

        const res = await fetch('/api/token');
        if (!res.ok) {
            const detail = await res.json().catch(() => ({}));
            throw new Error(detail.detail || `Token request failed (${res.status})`);
        }
        const { url, token } = await res.json();

        room = buildRoom();
        await room.connect(url, token);

        setCopy('Enabling your microphone…', 'Please allow microphone access if prompted.');
        await room.localParticipant.setMicrophoneEnabled(true);

        const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        if (pub?.track?.mediaStream) attachAnalyser(pub.track.mediaStream, 'mic');

        el.micBtn.classList.add('is-live');
        el.micBtn.setAttribute('aria-label', 'End conversation');
        el.micBtn.disabled = false;
        setCopy('Aura is listening', 'Speak naturally — she replies when you pause.');
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not connect.');
        setStatus('error', 'Failed');
        teardown('Could not connect. Check the terminal running main.py.');
    } finally {
        connecting = false;
        el.micBtn.disabled = false;
    }
}

function teardown(message) {
    if (room) {
        const r = room;
        room = null;
        try { r.disconnect(); } catch (_) { /* already down */ }
    }

    releaseAudio();
    document.querySelectorAll('audio[data-aura]').forEach((node) => node.remove());

    el.micBtn.classList.remove('is-live');
    el.micBtn.setAttribute('aria-label', 'Start conversation');
    el.micBtn.disabled = false;

    setTyping(false);
    if (el.statusPill.dataset.state !== 'error') setStatus('offline', 'Offline');
    setCopy('Tap to talk with Aura', message || 'Your microphone stays off until you connect.');
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

el.micBtn.addEventListener('click', () => {
    if (room) teardown();
    else connect();
});

el.clearBtn.addEventListener('click', clearConversation);

function magnetize(node, strength) {
    node.addEventListener('pointermove', (e) => {
        const r = node.getBoundingClientRect();
        node.style.setProperty('--tx', `${(e.clientX - r.left - r.width / 2) * strength}px`);
        node.style.setProperty('--ty', `${(e.clientY - r.top - r.height / 2) * strength}px`);
    });
    node.addEventListener('pointerleave', () => {
        node.style.setProperty('--tx', '0px');
        node.style.setProperty('--ty', '0px');
    });
}

if (!reduceMotion) {
    window.addEventListener('pointermove', (e) => {
        el.cursorGlow.style.left = `${e.clientX}px`;
        el.cursorGlow.style.top = `${e.clientY}px`;
    });

    document.querySelectorAll('.panel, .card').forEach((node) => {
        node.addEventListener('pointermove', (e) => {
            const r = node.getBoundingClientRect();
            node.style.setProperty('--mx', `${e.clientX - r.left}px`);
            node.style.setProperty('--my', `${e.clientY - r.top}px`);
        });
    });

    magnetize(el.micBtn, 0.28);
    document.querySelectorAll('.btn').forEach((btn) => magnetize(btn, 0.22));
}

/* -------------------------------------------------------------------------- */
/* Page chrome: sticky nav shadow + scroll reveal + footer CTA                */
/* -------------------------------------------------------------------------- */

const navEl = document.getElementById('nav');
window.addEventListener('scroll', () => {
    navEl.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

function countTo(node, target) {
    const t0 = performance.now();
    const dur = 1100;
    (function step(now) {
        const p = Math.min((now - t0) / dur, 1);
        node.textContent = `${Math.round(target * (1 - (1 - p) ** 3))} ms`;
        if (p < 1) requestAnimationFrame(step);
    })(t0);
}

const revealTargets = document.querySelectorAll('.rv');
if (reduceMotion) {
    revealTargets.forEach((node) => node.classList.add('in'));
    document.querySelectorAll('.bfill').forEach((f) => { f.style.transition = 'none'; f.style.width = `${f.dataset.w}%`; });
    document.querySelectorAll('.bval').forEach((node) => { node.textContent = `${node.dataset.n} ms`; });
} else {
    const reveal = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('in');
            if (entry.target.id === 'bars') {
                entry.target.querySelectorAll('.bfill').forEach((f, i) => {
                    setTimeout(() => { f.style.width = `${f.dataset.w}%`; }, i * 110);
                });
                entry.target.querySelectorAll('.bval').forEach((node, i) => {
                    setTimeout(() => countTo(node, Number(node.dataset.n)), i * 110);
                });
            }
            reveal.unobserve(entry.target);
        });
    }, { threshold: 0.2 });
    revealTargets.forEach((node, i) => {
        node.style.transitionDelay = `${(i % 4) * 70}ms`;
        reveal.observe(node);
    });
}

document.getElementById('footerTalk').addEventListener('click', () => {
    document.getElementById('talk').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    if (!room) el.micBtn.click();
});

window.addEventListener('beforeunload', () => {
    if (room) { try { room.disconnect(); } catch (_) { /* noop */ } }
});

setStatus('offline', 'Offline');
