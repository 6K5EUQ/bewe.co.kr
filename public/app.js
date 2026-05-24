// ── BEWE Globe Web ──────────────────────────────────────────────────────────
const canvas = document.getElementById('globe');
const tooltip = document.getElementById('tooltip');
const popup = document.getElementById('popup');
const stationCountEl = document.getElementById('station-count');

// ── Landing Page ────────────────────────────────────────────────────────────
const landing = document.getElementById('landing');
const globeUiEls = document.querySelectorAll('.globe-ui');
let landingVisible = true;

function enterGlobe() {
    landing.classList.add('fade-out');
    landingVisible = false;
    setTimeout(() => {
        landing.style.display = 'none';
        globeUiEls.forEach(el => el.style.display = '');
    }, 800);
}

function showLanding() {
    globeUiEls.forEach(el => el.style.display = 'none');
    landing.style.display = '';
    landing.classList.remove('fade-out');
    landingVisible = true;
    closePopup();
}

document.getElementById('btn-discover').addEventListener('click', enterGlobe);
document.getElementById('nav-discover').addEventListener('click', (e) => { e.preventDefault(); enterGlobe(); });
document.getElementById('btn-back').addEventListener('click', showLanding);

// ── About / PPT Modal ──────────────────────────────────────────────────────
(function setupAboutModal() {
    const modal = document.getElementById('about-modal');
    if (!modal) return;
    const slidesEl = document.getElementById('ppt-slides');
    const slides = Array.from(slidesEl.querySelectorAll('.ppt-slide'));
    const prevBtn = document.getElementById('ppt-prev');
    const nextBtn = document.getElementById('ppt-next');
    const closeBtn = document.getElementById('ppt-close');
    const pageEl = document.getElementById('ppt-page');
    const totalEl = document.getElementById('ppt-total');
    const fillEl = document.getElementById('ppt-progress-fill');
    const ovEl = document.getElementById('ppt-overview');

    let cur = 0;
    let liveTimer = null;
    totalEl.textContent = slides.length;

    // ── KPI count-up
    function animateCounters(slideEl) {
        slideEl.querySelectorAll('.kpi-num').forEach(el => {
            const raw = (el.dataset.target || '').trim();
            const suffix = el.dataset.suffix || '';
            const target = parseFloat(raw);
            if (raw === '' || isNaN(target) || /[^0-9.+\-eE]/.test(raw)) return;
            const dur = 1100;
            const start = performance.now();
            const isInt = Number.isInteger(target) && !raw.includes('.');
            const fmt = (v) => isInt ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
            const tick = (now) => {
                const p = Math.min(1, (now - start) / dur);
                const eased = 1 - Math.pow(1 - p, 3);
                el.textContent = fmt(target * eased) + suffix;
                if (p < 1) requestAnimationFrame(tick);
                else el.textContent = fmt(target) + suffix;
            };
            requestAnimationFrame(tick);
        });
    }

    // ── Live badge polling
    async function pollLive() {
        try {
            const r = await fetch('/api/status');
            if (!r.ok) return;
            const d = await r.json();
            const on = d.stations.filter(s => s.online);
            const ch = on.reduce((a, s) => a + (s.channel_count || 0), 0);
            const rec = on.filter(s => s.hist_recording).length;
            const users = on.reduce((a, s) => a + (s.users || 0), 0);
            const ageS = d.central.ageMs != null ? (d.central.ageMs / 1000).toFixed(1) : '--';
            document.querySelectorAll('.ppt-lb-sites').forEach(e => e.textContent = on.length);
            document.querySelectorAll('.ppt-lb-ch').forEach(e => e.textContent = ch);
            document.querySelectorAll('.ppt-lb-rec').forEach(e => e.textContent = rec);
            document.querySelectorAll('.ppt-lb-users').forEach(e => e.textContent = users);
            document.querySelectorAll('.ppt-lb-age').forEach(e => e.textContent = ageS);
        } catch(e) { /* silent */ }
    }
    function startLive() { if (!liveTimer) { pollLive(); liveTimer = setInterval(pollLive, 2000); } }
    function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

    // ── TDOA SVG interactive demo
    function initTDOA() {
        const svg = document.getElementById('ppt-tdoa');
        if (!svg || svg._tdoaInit) return;
        svg._tdoaInit = true;
        const nodes = [
            { x: 65,  y: 60,  ringId: 'tdoa-ring-a' },
            { x: 215, y: 60,  ringId: 'tdoa-ring-b' },
            { x: 130, y: 162, ringId: 'tdoa-ring-c' }
        ];
        let ex = 130, ey = 100, dragging = false;
        const emitter = document.getElementById('tdoa-emitter');
        const emitDot = document.getElementById('tdoa-emit-dot');
        const emitPulse = document.getElementById('tdoa-emit-pulse');
        const emitLbl = document.getElementById('tdoa-emit-lbl');
        const coordText = document.getElementById('tdoa-coord');
        function updateRings() {
            const dists = nodes.map(n => Math.hypot(ex - n.x, ey - n.y));
            nodes.forEach((n, i) => document.getElementById(n.ringId).setAttribute('r', Math.round(dists[i])));
            const lat = (38 - ey / 220 * 5).toFixed(2);
            const lon = (124 + ex / 280 * 6).toFixed(2);
            coordText.textContent = `추정 좌표 ${lat}N  ${lon}E  |  CEP ~${Math.round(Math.min(...dists) * 0.3)} m`;
        }
        function getSVGXY(clientX, clientY) {
            const rect = svg.getBoundingClientRect();
            const vb = svg.viewBox.baseVal;
            return {
                x: Math.max(10, Math.min(vb.width - 10, (clientX - rect.left) / rect.width * vb.width)),
                y: Math.max(10, Math.min(vb.height - 22, (clientY - rect.top) / rect.height * vb.height))
            };
        }
        function moveEmitter(x, y) {
            ex = x; ey = y;
            emitDot.setAttribute('cx', x); emitDot.setAttribute('cy', y);
            emitPulse.setAttribute('cx', x); emitPulse.setAttribute('cy', y);
            emitLbl.setAttribute('x', x); emitLbl.setAttribute('y', y - 11);
            updateRings();
        }
        emitter.addEventListener('mousedown', (e) => { e.stopPropagation(); dragging = true; emitter.style.cursor = 'grabbing'; });
        svg.addEventListener('mousemove', (e) => { if (dragging) { const {x, y} = getSVGXY(e.clientX, e.clientY); moveEmitter(x, y); } });
        document.addEventListener('mouseup', () => { if (dragging) { dragging = false; emitter.style.cursor = 'grab'; } });
        emitter.addEventListener('touchstart', (e) => { e.stopPropagation(); dragging = true; }, { passive: true });
        svg.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            e.preventDefault();
            const t = e.touches[0];
            const {x, y} = getSVGXY(t.clientX, t.clientY);
            moveEmitter(x, y);
        }, { passive: false });
        document.addEventListener('touchend', () => { dragging = false; });
        updateRings();
    }

    // ── Overview grid (O key)
    function buildOverview() {
        ovEl.innerHTML = '';
        slides.forEach((s, i) => {
            const item = document.createElement('div');
            item.className = 'ppt-ov-item' + (i === cur ? ' ov-active' : '');
            item.innerHTML = `<span class="ppt-ov-num">${String(i+1).padStart(2,'0')}</span><span class="ppt-ov-title">${s.dataset.title || ''}</span>`;
            item.addEventListener('click', () => { go(i); closeOverview(); });
            ovEl.appendChild(item);
        });
    }
    function closeOverview() { ovEl.classList.add('hidden'); }
    function toggleOverview() {
        if (ovEl.classList.contains('hidden')) { buildOverview(); ovEl.classList.remove('hidden'); }
        else closeOverview();
    }

    // ── Render
    function render() {
        slides.forEach((s, i) => {
            s.classList.toggle('active', i === cur);
            s.classList.toggle('prev', i < cur);
        });
        pageEl.textContent = cur + 1;
        fillEl.style.width = ((cur + 1) / slides.length * 100) + '%';
        prevBtn.disabled = cur === 0;
        nextBtn.disabled = cur === slides.length - 1;
        setTimeout(() => {
            animateCounters(slides[cur]);
            if (slides[cur].querySelector('.ppt-live-badge')) startLive(); else stopLive();
            if (slides[cur].querySelector('#ppt-tdoa')) initTDOA();
            slidesEl.querySelectorAll('video').forEach(v => {
                if (slides[cur].contains(v)) v.play().catch(()=>{});
                else { v.pause(); try { v.currentTime = 0; } catch(e) {} }
            });
        }, 350);
    }
    function go(n) { cur = Math.max(0, Math.min(slides.length - 1, n)); render(); }
    function nextSlide() { go(cur + 1); }
    function prevSlide() { go(cur - 1); }

    function openModal() {
        cur = 0;
        modal.classList.remove('hidden');
        render();
    }
    function closeModal() {
        if (!ovEl.classList.contains('hidden')) { closeOverview(); return; }
        if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
        stopLive();
        modal.classList.add('hidden');
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
    function toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
        else (modal.requestFullscreen ? modal.requestFullscreen() : modal.webkitRequestFullscreen?.())?.catch?.(()=>{});
    }

    document.getElementById('nav-about').addEventListener('click', (e) => { e.preventDefault(); openModal(); });
    closeBtn.addEventListener('click', closeModal);
    prevBtn.addEventListener('click', prevSlide);
    nextBtn.addEventListener('click', nextSlide);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Touch swipe
    let touchX0 = 0;
    modal.addEventListener('touchstart', (e) => { touchX0 = e.touches[0].clientX; }, { passive: true });
    modal.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchX0;
        if (Math.abs(dx) > 50) { if (dx < 0) nextSlide(); else prevSlide(); }
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('hidden')) return;
        if (e.key === 'Escape') { closeModal(); return; }
        if (!ovEl.classList.contains('hidden')) {
            if (e.key === 'o' || e.key === 'O') { e.preventDefault(); closeOverview(); }
            return;
        }
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); nextSlide(); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prevSlide(); }
        else if (e.key === 'Home') { e.preventDefault(); go(0); }
        else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
        else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
        else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); toggleOverview(); }
        else if (e.key >= '1' && e.key <= '9') { e.preventDefault(); go(parseInt(e.key) - 1); }
    });

    render();
})();

// ── Three.js Setup ──────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 3.5);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Stars ───────────────────────────────────────────────────────────────────
(function createStars() {
    const geo = new THREE.BufferGeometry();
    const n = 3000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 30 + Math.random() * 20;
        pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
        pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
        pos[i*3+2] = r * Math.cos(phi);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.05, sizeAttenuation: true });
    scene.add(new THREE.Points(geo, mat));
})();

// ── Globe ───────────────────────────────────────────────────────────────────
const GLOBE_RADIUS = 1.0;
const globeGeo = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48);

// Custom shader for rim glow
const globeMat = new THREE.ShaderMaterial({
    uniforms: {
        uTexture: { value: null },
        hasTexture: { value: 0.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D uTexture;
        uniform float hasTexture;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
            vec3 viewDir = normalize(-vPosition);
            float rim = 1.0 - max(dot(viewDir, vNormal), 0.0);
            rim = pow(rim, 2.5);
            vec3 baseColor;
            if (hasTexture > 0.5) {
                baseColor = texture2D(uTexture, vUv).rgb;
                // Darken slightly for cinematic feel
                baseColor *= 0.85;
            } else {
                baseColor = vec3(0.04, 0.10, 0.28);
            }
            vec3 rimColor = vec3(0.3, 0.5, 0.9);
            vec3 final = baseColor + rimColor * rim * 0.5;
            gl_FragColor = vec4(final, 1.0);
        }
    `
});

const globe = new THREE.Mesh(globeGeo, globeMat);
scene.add(globe);

// Atmosphere glow
const atmosGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.03, 64, 48);
const atmosMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
            vec3 viewDir = normalize(-vPosition);
            float intensity = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 3.0);
            gl_FragColor = vec4(0.3, 0.5, 1.0, intensity * 0.35);
        }
    `,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false
});
scene.add(new THREE.Mesh(atmosGeo, atmosMat));

// Load earth texture
const texLoader = new THREE.TextureLoader();
texLoader.load('assets/earth.jpg', (tex) => {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    globeMat.uniforms.uTexture.value = tex;
    globeMat.uniforms.hasTexture.value = 1.0;
});

// ── Station Markers ─────────────────────────────────────────────────────────
let stations = [];
const markerGroup = new THREE.Group();
scene.add(markerGroup);

function latLonToVec3(lat, lon, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
         r * Math.cos(phi),
         r * Math.sin(phi) * Math.sin(theta)
    );
}

function createMarkerSprite() {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');

    // Outer glow
    const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    grad.addColorStop(0,   'rgba(100,180,255,0.9)');
    grad.addColorStop(0.25,'rgba(60,140,255,0.6)');
    grad.addColorStop(0.5, 'rgba(40,100,220,0.2)');
    grad.addColorStop(1,   'rgba(20,60,160,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Core
    ctx.beginPath();
    ctx.arc(size/2, size/2, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    const tex = new THREE.CanvasTexture(cv);
    return tex;
}

const markerTex = createMarkerSprite();

function updateMarkers() {
    // Remove old markers
    while (markerGroup.children.length) markerGroup.remove(markerGroup.children[0]);

    stations.forEach((st, i) => {
        const pos = latLonToVec3(st.lat, st.lon, GLOBE_RADIUS * 1.005);
        const mat = new THREE.SpriteMaterial({
            map: markerTex,
            transparent: true,
            depthTest: true,
            blending: THREE.AdditiveBlending
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        sprite.scale.set(0.08, 0.08, 1);
        sprite.userData = { stationIdx: i };
        markerGroup.add(sprite);
    });
}

// ── Pulse animation for markers ─────────────────────────────────────────────
let pulseTime = 0;
function animateMarkers(dt) {
    pulseTime += dt;
    const pulse = 0.08 + Math.sin(pulseTime * 2.5) * 0.015;
    markerGroup.children.forEach(s => s.scale.set(pulse, pulse, 1));
}

// ── Mouse Interaction ───────────────────────────────────────────────────────
let isDragging = false;
let prevMouse = { x: 0, y: 0 };
let dragAxis = null; // 'x' or 'y' — locked after threshold
let dragOrigin = { x: 0, y: 0 };
const AXIS_LOCK_THRESHOLD = 3; // px before axis is decided
let targetRotX = -0.18; // Initial view: slightly tilted to show Korea
let targetRotY = -2.22; // ~127E longitude
let rotX = targetRotX;
let rotY = targetRotY;
let zoomDist = 3.5;
let targetZoom = 3.5;

canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
        isDragging = true;
        dragAxis = null;
        prevMouse = { x: e.clientX, y: e.clientY };
        dragOrigin = { x: e.clientX, y: e.clientY };
    }
});

window.addEventListener('mouseup', () => { isDragging = false; dragAxis = null; });

window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        const dx = e.clientX - prevMouse.x;
        const dy = e.clientY - prevMouse.y;

        // Lock axis once movement exceeds threshold
        if (!dragAxis) {
            const totalDx = Math.abs(e.clientX - dragOrigin.x);
            const totalDy = Math.abs(e.clientY - dragOrigin.y);
            if (totalDx >= AXIS_LOCK_THRESHOLD || totalDy >= AXIS_LOCK_THRESHOLD) {
                dragAxis = totalDx >= totalDy ? 'x' : 'y';
            }
        }

        const scale = zoomDist / 3.5 * 0.005;
        if (dragAxis === 'x') targetRotY += dx * scale;
        if (dragAxis === 'y') {
            targetRotX += dy * scale;
            targetRotX = Math.max(-Math.PI/2, Math.min(Math.PI/2, targetRotX));
        }
        prevMouse = { x: e.clientX, y: e.clientY };
    }
    handleHover(e);
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    targetZoom += e.deltaY * 0.002;
    targetZoom = Math.max(1.5, Math.min(8.0, targetZoom));
}, { passive: false });

canvas.addEventListener('click', (e) => {
    handleClick(e);
});

// ── Hover / Click Detection ─────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse2d = new THREE.Vector2();

function getHoveredStation(e) {
    mouse2d.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse2d.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse2d, camera);

    // Check distance to each marker in screen space
    let bestDist = 25; // pixel threshold
    let bestIdx = -1;

    stations.forEach((st, i) => {
        const pos = latLonToVec3(st.lat, st.lon, GLOBE_RADIUS * 1.005);
        // Apply globe rotation
        pos.applyEuler(new THREE.Euler(rotX, rotY, 0, 'XYZ'));
        const projected = pos.clone().project(camera);
        const sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;
        const dist = Math.hypot(e.clientX - sx, e.clientY - sy);

        // Check if marker is on visible side (not behind globe)
        const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const toMarker = pos.clone().sub(camera.position).normalize();
        if (projected.z > 1) return; // Behind camera

        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    });
    return bestIdx;
}

function handleHover(e) {
    if (popup.classList.contains('hidden') === false) return;
    const idx = getHoveredStation(e);
    if (idx >= 0) {
        const st = stations[idx];
        const tierLabel = `Tier ${st.tier}`;
        const tierClass = st.tier === 1 ? 'tier-tag-red' : st.tier === 3 ? 'tier-tag-green' : 'tier-tag';
        tooltip.innerHTML = `${st.name} <span class="${tierClass}">${tierLabel}</span>`;
        tooltip.style.left = (e.clientX + 16) + 'px';
        tooltip.style.top = (e.clientY - 10) + 'px';
        tooltip.classList.remove('hidden');
        canvas.style.cursor = 'pointer';
    } else {
        tooltip.classList.add('hidden');
        canvas.style.cursor = isDragging ? 'grabbing' : 'grab';
    }
}

function handleClick(e) {
    if (isDragging) return;
    const idx = getHoveredStation(e);
    if (idx >= 0) {
        showPopup(stations[idx]);
    } else if (!popup.classList.contains('hidden')) {
        closePopup();
    }
}

function showPopup(st) {
    document.getElementById('popup-name').textContent = st.name;

    const latDir = st.lat >= 0 ? 'N' : 'S';
    const lonDir = st.lon >= 0 ? 'E' : 'W';
    document.getElementById('popup-coords').textContent =
        `${Math.abs(st.lat).toFixed(4)}°${latDir}  ${Math.abs(st.lon).toFixed(4)}°${lonDir}`;

    document.getElementById('popup-users').textContent =
        `${st.users} Operator(s) connected`;

    const hostName = st.station_id.includes('_') ? st.station_id.split('_').slice(1).join('_') : st.station_id;
    const tierEl = document.getElementById('popup-tier');
    tierEl.textContent = `host by ${hostName}`;
    tierEl.className = 'popup-tier tier-gray';

    popup.classList.remove('hidden');
    tooltip.classList.add('hidden');
}

function closePopup() {
    popup.classList.add('hidden');
}

// ── Aircraft Layer (ADS-B via OpenSky) ──────────────────────────────────────
const MAX_AIRCRAFT = 15000;
const acGeo = new THREE.BufferGeometry();
const acPositions = new Float32Array(MAX_AIRCRAFT * 3);
const acHeadings = new Float32Array(MAX_AIRCRAFT);
acGeo.setAttribute('position', new THREE.BufferAttribute(acPositions, 3));
acGeo.setAttribute('heading', new THREE.BufferAttribute(acHeadings, 1));
acGeo.setDrawRange(0, 0);

function createPlaneTexture() {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const cx = size / 2, cy = size / 2;
    ctx.fillStyle = '#fff';
    // fuselage
    ctx.beginPath();
    ctx.ellipse(cx, cy, 3, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    // wings
    ctx.beginPath();
    ctx.moveTo(cx, cy - 2);
    ctx.lineTo(cx - 16, cy + 4);
    ctx.lineTo(cx - 14, cy + 7);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx + 14, cy + 7);
    ctx.lineTo(cx + 16, cy + 4);
    ctx.closePath();
    ctx.fill();
    // tail
    ctx.beginPath();
    ctx.moveTo(cx, cy + 10);
    ctx.lineTo(cx - 7, cy + 16);
    ctx.lineTo(cx - 6, cy + 18);
    ctx.lineTo(cx, cy + 13);
    ctx.lineTo(cx + 6, cy + 18);
    ctx.lineTo(cx + 7, cy + 16);
    ctx.closePath();
    ctx.fill();
    return new THREE.CanvasTexture(cv);
}

const acTex = createPlaneTexture();
const acMat = new THREE.ShaderMaterial({
    uniforms: {
        uTexture: { value: acTex },
        uSize: { value: 0.054 }
    },
    vertexShader: `
        attribute float heading;
        varying float vHeading;
        uniform float uSize;
        void main() {
            vHeading = heading;
            vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = uSize * (300.0 / -mvPos.z);
            gl_Position = projectionMatrix * mvPos;
        }
    `,
    fragmentShader: `
        uniform sampler2D uTexture;
        varying float vHeading;
        void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float angle = -vHeading;
            float c = cos(angle);
            float s = sin(angle);
            vec2 rotUv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
            vec4 texColor = texture2D(uTexture, rotUv);
            if (texColor.a < 0.1) discard;
            gl_FragColor = vec4(1.0, 0.75, 0.2, 1.0) * texColor;
        }
    `,
    transparent: true,
    depthTest: true
});
const acPoints = new THREE.Points(acGeo, acMat);
scene.add(acPoints);

function updateAircraft(data) {
    const count = Math.min(data.length, MAX_AIRCRAFT);
    for (let i = 0; i < count; i++) {
        const lat = data[i][0];
        const lon = data[i][1];
        const hdg = (data[i][2] || 0) * Math.PI / 180;
        const pos = latLonToVec3(lat, lon, GLOBE_RADIUS * 1.012);
        acPositions[i * 3]     = pos.x;
        acPositions[i * 3 + 1] = pos.y;
        acPositions[i * 3 + 2] = pos.z;
        acHeadings[i] = hdg;
    }
    acGeo.attributes.position.needsUpdate = true;
    acGeo.attributes.heading.needsUpdate = true;
    acGeo.setDrawRange(0, count);
}

async function pollAircraft() {
    try {
        const res = await fetch('/api/aircraft');
        if (res.ok) updateAircraft(await res.json());
    } catch (e) { /* silent */ }
}
pollAircraft();
setInterval(pollAircraft, 10000);

// ── Station Polling ─────────────────────────────────────────────────────────
const landingStationCount = document.getElementById('landing-station-count');

async function pollStations() {
    try {
        const res = await fetch('/api/stations');
        if (res.ok) {
            stations = await res.json();
            updateMarkers();
            stationCountEl.textContent = stations.length === 0
                ? 'No Stations Online'
                : `${stations.length} Station${stations.length > 1 ? 's' : ''} Online`;
            if (landingStationCount) landingStationCount.textContent = stations.length;
        }
    } catch (e) { /* silent */ }
}
pollStations();
setInterval(pollStations, 1000);

// ── Render Loop ─────────────────────────────────────────────────────────────
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Smooth rotation
    rotX += (targetRotX - rotX) * 0.08;
    rotY += (targetRotY - rotY) * 0.08;
    zoomDist += (targetZoom - zoomDist) * 0.08;

    // Auto-rotate when not dragging
    if (!isDragging && popup.classList.contains('hidden')) {
        targetRotY += dt * 0.03;
    }

    // Apply rotation to globe + markers
    globe.rotation.set(rotX, rotY, 0, 'XYZ');
    markerGroup.rotation.set(rotX, rotY, 0, 'XYZ');
    acPoints.rotation.set(rotX, rotY, 0, 'XYZ');

    // Camera zoom
    camera.position.z = zoomDist;

    // Animate marker pulse
    animateMarkers(dt);

    renderer.render(scene, camera);
}
animate();
