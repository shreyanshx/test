// TestPaper SPA - Dynamic High-Graphics Animated Homepage & Assessment OS
// Connects to /api/* routes served by the Cloudflare Worker

const appEl = document.getElementById("app");
const topbar = document.getElementById("topbar");
const whoEl = document.getElementById("who");
const logoutBtn = document.getElementById("logout-btn");
const landingPage = document.getElementById("landing-page");
const topTicker = document.getElementById("top-ticker");
const authModal = document.getElementById("authModal");

let currentUser = null;
let currentAuthMode = "login";

// ---- API CLIENT HELPERS ----

async function api(path, options = {}) {
  const opts = {
    credentials: "same-origin",
    headers: {},
    ...options,
  };
  if (opts.body !== undefined && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child
    );
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---- BOOT & SESSION STATE ----

async function boot() {
  try {
    const data = await api("/api/auth/me");
    currentUser = data.user;
    renderApp();
  } catch (e) {
    currentUser = null;
    showLandingPage();
  }
}

function showLandingPage() {
  currentUser = null;
  if (topbar) topbar.hidden = true;
  if (appEl) appEl.hidden = true;
  if (landingPage) landingPage.style.display = "block";
  if (topTicker) topTicker.style.display = "flex";
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderApp() {
  if (!currentUser) return showLandingPage();
  if (landingPage) landingPage.style.display = "none";
  if (topTicker) topTicker.style.display = "none";
  if (topbar) {
    topbar.hidden = false;
    whoEl.textContent = `${currentUser.name} (${currentUser.role.toUpperCase()})`;
  }
  if (appEl) {
    appEl.hidden = false;
    if (currentUser.role === "prof") renderProfDashboard();
    else renderStudentDashboard();
  }
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    currentUser = null;
    showLandingPage();
  });
}

function handleAuthError(e) {
  if (e && e.status === 401) {
    showLandingPage();
    return true;
  }
  return false;
}

// ---- PROFESSOR DASHBOARD ----

async function renderProfDashboard() {
  clear(appEl);
  appEl.appendChild(el("h1", {}, "Professor Assessment Console"));

  // Create paper card
  const createCard = el("div", { class: "card" });
  createCard.appendChild(el("h2", {}, "Author New Test Paper"));
  const titleInput = el("input", { type: "text", placeholder: "Midterm Exam - Operating Systems" });
  const subjInput = el("input", { type: "text", placeholder: "Computer Science" });
  const descInput = el("textarea", { placeholder: "Examination rules and guidelines..." });
  const createErr = el("p", { class: "error" });
  const createBtn = el("button", { class: "btn btn-primary btn-glow" }, "Create Paper");
  createCard.appendChild(el("label", {}, "Paper Title"));
  createCard.appendChild(titleInput);
  createCard.appendChild(el("label", {}, "Academic Subject"));
  createCard.appendChild(subjInput);
  createCard.appendChild(el("label", {}, "Instructions (Optional)"));
  createCard.appendChild(descInput);
  createCard.appendChild(el("div", { class: "actions", style: "margin-top:1.2rem;" }, [createBtn]));
  createCard.appendChild(createErr);

  createBtn.addEventListener("click", async () => {
    createErr.textContent = "";
    try {
      await api("/api/papers", {
        method: "POST",
        body: {
          title: titleInput.value.trim(),
          subject: subjInput.value.trim(),
          description: descInput.value.trim(),
        },
      });
      titleInput.value = "";
      subjInput.value = "";
      descInput.value = "";
      renderProfDashboard();
    } catch (e) {
      if (!handleAuthError(e)) createErr.textContent = e.message;
    }
  });
  appEl.appendChild(createCard);

  // Papers list
  const listCard = el("div", { class: "card" });
  listCard.appendChild(el("h2", {}, "Your Authored Papers"));
  appEl.appendChild(listCard);

  try {
    const { papers } = await api("/api/papers");
    if (!papers.length) {
      listCard.appendChild(el("p", { class: "muted" }, "No examination papers yet. Create your first paper above."));
    }
    for (const p of papers) {
      const pill = el(
        "span",
        { class: "pill " + (p.published ? "pill-published" : "pill-draft") },
        p.published ? "Published" : "Draft"
      );
      const item = el("div", { class: "list-item" }, [
        el("div", {}, [
          el("div", {}, [el("strong", { style: "font-size:1.1rem; color:#fff;" }, p.title), " ", pill]),
          el(
            "div",
            { class: "meta" },
            [p.subject || "No subject", " · Created: ", p.created_at].join("")
          ),
        ]),
        el("div", { class: "row" }, [
          el(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => renderPaperEditor(p.id) },
            "Manage Questions"
          ),
        ]),
      ]);
      listCard.appendChild(item);
    }
  } catch (e) {
    if (!handleAuthError(e)) {
      listCard.appendChild(el("p", { class: "error" }, e.message));
    }
  }
}

async function renderPaperEditor(paperId) {
  clear(appEl);
  appEl.appendChild(
    el("button", { class: "link", onclick: renderProfDashboard }, "← Back to Dashboard")
  );

  let detail;
  try {
    detail = await api(`/api/papers/${paperId}`);
  } catch (e) {
    if (handleAuthError(e)) return;
    appEl.appendChild(el("p", { class: "error" }, e.message));
    return;
  }
  const { paper, questions } = detail;

  const head = el("div", { class: "card" });
  head.appendChild(el("h1", {}, paper.title));
  head.appendChild(
    el(
      "p",
      { class: "muted" },
      (paper.subject || "No subject") + (paper.description ? " · " + paper.description : "")
    )
  );
  const pubBtn = el(
    "button",
    { class: "btn " + (paper.published ? "btn-ghost" : "btn-primary") },
    paper.published ? "Unpublish Paper" : "Publish to Students"
  );
  const delBtn = el("button", { class: "btn btn-danger" }, "Delete Paper");
  const headErr = el("p", { class: "error" });
  head.appendChild(el("div", { class: "actions", style: "margin-top:1.2rem;" }, [pubBtn, delBtn]));
  head.appendChild(headErr);
  appEl.appendChild(head);

  pubBtn.addEventListener("click", async () => {
    headErr.textContent = "";
    try {
      await api(`/api/papers/${paperId}`, {
        method: "PUT",
        body: { published: !paper.published },
      });
      renderPaperEditor(paperId);
    } catch (e) {
      if (!handleAuthError(e)) headErr.textContent = e.message;
    }
  });
  delBtn.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete this test paper and all student submissions?")) return;
    headErr.textContent = "";
    try {
      await api(`/api/papers/${paperId}`, { method: "DELETE" });
      renderProfDashboard();
    } catch (e) {
      if (!handleAuthError(e)) headErr.textContent = e.message;
    }
  });

  // Questions
  const qCard = el("div", { class: "card" });
  qCard.appendChild(el("h2", {}, `Questions Configured (${questions.length})`));
  for (const q of questions) {
    const block = el("div", { class: "question-block" });
    block.appendChild(el("div", {}, [el("strong", { style: "color:var(--primary);" }, `Q${q.position}. `), q.prompt]));
    if (q.options && q.options.length) {
      block.appendChild(
        el("div", { class: "meta" }, "Options: " + q.options.join(", "))
      );
    }
    block.appendChild(
      el(
        "div",
        { class: "meta", style: "color:var(--neon-green);" },
        `Correct Answer: ${q.correct_answer} · [${q.points} pt(s)]`
      )
    );
    qCard.appendChild(block);
  }
  appEl.appendChild(qCard);

  // Add question
  const addCard = el("div", { class: "card" });
  addCard.appendChild(el("h2", {}, "Add Question"));
  const promptInput = el("textarea", { placeholder: "What is the primary function of an operating system kernel?" });
  const optionsInput = el("input", {
    type: "text",
    placeholder: "Optional comma-separated choices (e.g. Memory management, Graphics, Sound, Compiler)",
  });
  const answerInput = el("input", { type: "text", placeholder: "Correct answer (e.g. Memory management)" });
  const pointsInput = el("input", { type: "number", value: "1", min: "1" });
  const addErr = el("p", { class: "error" });
  const addBtn = el("button", { class: "btn btn-primary" }, "Add Question");

  addCard.appendChild(el("label", {}, "Question Prompt"));
  addCard.appendChild(promptInput);
  addCard.appendChild(el("label", {}, "Multiple Choice Options (Optional)"));
  addCard.appendChild(optionsInput);
  addCard.appendChild(el("label", {}, "Correct Answer Key"));
  addCard.appendChild(answerInput);
  addCard.appendChild(el("label", {}, "Points"));
  addCard.appendChild(pointsInput);
  addCard.appendChild(el("div", { class: "actions", style: "margin-top:1.2rem;" }, [addBtn]));
  addCard.appendChild(addErr);

  addBtn.addEventListener("click", async () => {
    addErr.textContent = "";
    const options = optionsInput.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    try {
      await api(`/api/papers/${paperId}/questions`, {
        method: "POST",
        body: {
          prompt: promptInput.value.trim(),
          options: options.length ? options : undefined,
          correct_answer: answerInput.value.trim(),
          points: Number(pointsInput.value) || 1,
        },
      });
      renderPaperEditor(paperId);
    } catch (e) {
      if (!handleAuthError(e)) addErr.textContent = e.message;
    }
  });
  appEl.appendChild(addCard);

  // Submissions
  const subCard = el("div", { class: "card" });
  subCard.appendChild(el("h2", {}, "Student Submissions & Grades"));
  appEl.appendChild(subCard);
  try {
    const { submissions } = await api(`/api/papers/${paperId}/submissions`);
    if (!submissions.length) {
      subCard.appendChild(el("p", { class: "muted" }, "No student submissions yet."));
    } else {
      const table = el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Student"),
          el("th", {}, "Email"),
          el("th", {}, "Score"),
          el("th", {}, "Submitted At"),
        ])),
      ]);
      const tbody = el("tbody");
      for (const s of submissions) {
        tbody.appendChild(
          el("tr", {}, [
            el("td", {}, s.student_name),
            el("td", {}, s.student_email),
            el("td", { style: "color:var(--primary); font-weight:700;" }, `${s.score} / ${s.max_score}`),
            el("td", {}, s.submitted_at),
          ])
        );
      }
      table.appendChild(tbody);
      subCard.appendChild(table);
    }
  } catch (e) {
    if (!handleAuthError(e)) {
      subCard.appendChild(el("p", { class: "error" }, e.message));
    }
  }
}

// ---- STUDENT DASHBOARD ----

async function renderStudentDashboard() {
  clear(appEl);
  appEl.appendChild(el("h1", {}, "Student Examination Portal"));
  const listCard = el("div", { class: "card" });
  appEl.appendChild(listCard);

  try {
    const { papers } = await api("/api/papers");
    if (!papers.length) {
      listCard.appendChild(el("p", { class: "muted" }, "No published examination papers available at this time."));
    }
    for (const p of papers) {
      const item = el("div", { class: "list-item" }, [
        el("div", {}, [
          el("div", {}, el("strong", { style: "font-size:1.1rem; color:#fff;" }, p.title)),
          el("div", { class: "meta" }, p.subject || "General Assessment"),
          p.description ? el("div", { class: "meta" }, p.description) : null,
        ]),
        el("div", { class: "row" }, [
          el(
            "button",
            { class: "btn btn-primary btn-sm", onclick: () => renderTakePaper(p.id) },
            "Take Exam →"
          ),
        ]),
      ]);
      listCard.appendChild(item);
    }
  } catch (e) {
    if (!handleAuthError(e)) listCard.appendChild(el("p", { class: "error" }, e.message));
  }
}

async function renderTakePaper(paperId) {
  clear(appEl);
  appEl.appendChild(
    el("button", { class: "link", onclick: renderStudentDashboard }, "← Back to Available Papers")
  );

  let detail;
  try {
    detail = await api(`/api/papers/${paperId}`);
  } catch (e) {
    if (handleAuthError(e)) return;
    appEl.appendChild(el("p", { class: "error" }, e.message));
    return;
  }
  const { paper, questions } = detail;

  let existing = null;
  try {
    const r = await api(`/api/papers/${paperId}/result`);
    existing = r.result;
  } catch (e) {
    if (e.status && e.status !== 404) {
      if (handleAuthError(e)) return;
    }
  }

  const head = el("div", { class: "card" });
  head.appendChild(el("h1", {}, paper.title));
  head.appendChild(el("p", { class: "muted" }, paper.subject || "No subject"));
  if (paper.description) head.appendChild(el("p", {}, paper.description));
  appEl.appendChild(head);

  const resultBanner = el("div", { class: "card", style: existing ? "" : "display:none" });
  if (existing) {
    resultBanner.appendChild(
      el(
        "div",
        { class: "score-banner" },
        `Your Verified Score: ${existing.score} / ${existing.max_score}`
      )
    );
  }
  appEl.appendChild(resultBanner);

  const form = el("div", { class: "card" });
  form.appendChild(el("h2", {}, "Assessment Questions"));
  const inputs = {};
  const prevAnswers = existing ? existing.answers || {} : {};

  for (const q of questions) {
    const block = el("div", { class: "question-block" });
    block.appendChild(el("div", {}, [el("strong", { style: "color:var(--primary);" }, `Q${q.position}. `), q.prompt]));
    block.appendChild(el("div", { class: "meta" }, `${q.points} point(s)`));

    if (q.options && q.options.length) {
      for (const opt of q.options) {
        const radio = el("input", {
          type: "radio",
          name: `q${q.id}`,
          value: opt,
        });
        if (String(prevAnswers[q.id]) === opt) radio.checked = true;
        if (!inputs[q.id]) inputs[q.id] = { type: "radio", nodes: [] };
        inputs[q.id].nodes.push(radio);
        block.appendChild(
          el("label", { class: "option-label" }, [radio, opt])
        );
      }
    } else {
      const text = el("input", { type: "text", placeholder: "Type your answer" });
      if (prevAnswers[q.id] !== undefined) text.value = prevAnswers[q.id];
      inputs[q.id] = { type: "text", node: text };
      block.appendChild(text);
    }
    form.appendChild(block);
  }

  const submitErr = el("p", { class: "error" });
  const submitBtn = el(
    "button",
    { class: "btn btn-primary btn-glow", style: "width:100%; margin-top:1rem;" },
    existing ? "Resubmit Answers" : "Submit Examination"
  );

  submitBtn.addEventListener("click", async () => {
    submitErr.textContent = "";
    const answers = {};
    for (const [qid, entry] of Object.entries(inputs)) {
      if (entry.type === "radio") {
        const checked = entry.nodes.find((n) => n.checked);
        if (checked) answers[qid] = checked.value;
      } else {
        if (entry.node.value.trim()) answers[qid] = entry.node.value.trim();
      }
    }
    try {
      const { result } = await api(`/api/papers/${paperId}/submit`, {
        method: "POST",
        body: { answers },
      });
      resultBanner.style.display = "";
      clear(resultBanner);
      resultBanner.appendChild(
        el(
          "div",
          { class: "score-banner" },
          `Your Verified Score: ${result.score} / ${result.max_score}`
        )
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (!handleAuthError(e)) submitErr.textContent = e.message;
    }
  });

  if (!questions.length) {
    form.appendChild(el("p", { class: "muted" }, "This examination has no questions published yet."));
  } else {
    form.appendChild(el("div", { class: "actions" }, [submitBtn]));
    form.appendChild(submitErr);
  }
  appEl.appendChild(form);
}

// ---- DYNAMIC HOMEPAGE INTERACTIVE LOGIC ----

// 1. Web Audio SFX
let audioCtx = null;
let sfxEnabled = false;

window.toggleAudioFx = function() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sfxEnabled = !sfxEnabled;
  const soundIcon = document.getElementById("soundIcon");
  const soundText = document.getElementById("soundText");
  if (sfxEnabled) {
    soundIcon.innerText = "🔊";
    soundText.innerText = "SFX ON";
    playTone(660, "sine", 0.12);
  } else {
    soundIcon.innerText = "🔇";
    soundText.innerText = "SFX OFF";
  }
};

function playTone(freq, type = "sine", duration = 0.1) {
  if (!sfxEnabled || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {}
}

window.playClickFx = function() {
  playTone(880, "sine", 0.08);
};

// 2. Scroll Progress & Header State
const progressBar = document.getElementById("scroll-progress");
const landingHeader = document.getElementById("landing-header");
const backToTopBtn = document.getElementById("back-to-top");

window.addEventListener("scroll", () => {
  const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
  const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  if (progressBar) progressBar.style.width = ((winScroll / height) * 100) + "%";

  if (landingHeader) {
    if (winScroll > 40) landingHeader.classList.add("scrolled");
    else landingHeader.classList.remove("scrolled");
  }

  if (backToTopBtn) {
    if (winScroll > 400) backToTopBtn.classList.add("visible");
    else backToTopBtn.classList.remove("visible");
  }
});

// 3. Mouse Spotlight Glow & 3D Tilt
const cursorLight = document.getElementById("cursor-light");
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;

window.addEventListener("mousemove", (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  if (cursorLight) cursorLight.style.transform = `translate(${mouseX - 325}px, ${mouseY - 325}px)`;
});

const heroCard = document.getElementById("interactive-hero-card");
if (heroCard) {
  document.addEventListener("mousemove", (e) => {
    const xAxis = (window.innerWidth / 2 - e.pageX) / 45;
    const yAxis = (window.innerHeight / 2 - e.pageY) / 45;
    heroCard.style.transform = `rotateY(${xAxis - 6}deg) rotateX(${yAxis + 4}deg)`;
  });
}

// 4. Interactive Constellation Canvas
const pCanvas = document.getElementById("particle-canvas");
if (pCanvas) {
  const pCtx = pCanvas.getContext("2d");
  let particles = [];
  const particleCount = 85;

  function resizeCanvas() {
    pCanvas.width = window.innerWidth;
    pCanvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  class Particle {
    constructor() {
      this.x = Math.random() * pCanvas.width;
      this.y = Math.random() * pCanvas.height;
      this.vx = (Math.random() - 0.5) * 0.75;
      this.vy = (Math.random() - 0.5) * 0.75;
      this.radius = Math.random() * 2 + 1;
      this.color = Math.random() > 0.6 ? "#38bdf8" : (Math.random() > 0.5 ? "#818cf8" : "#c084fc");
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < 0 || this.x > pCanvas.width) this.vx *= -1;
      if (this.y < 0 || this.y > pCanvas.height) this.vy *= -1;

      const dx = mouseX - this.x;
      const dy = mouseY - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150) {
        this.x -= (dx / dist) * 1.6;
        this.y -= (dy / dist) * 1.6;
      }
    }
    draw() {
      pCtx.beginPath();
      pCtx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      pCtx.fillStyle = this.color;
      pCtx.shadowBlur = 8;
      pCtx.shadowColor = this.color;
      pCtx.fill();
    }
  }

  for (let i = 0; i < particleCount; i++) particles.push(new Particle());

  function animateParticles() {
    pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 135) {
          pCtx.beginPath();
          pCtx.moveTo(particles[i].x, particles[i].y);
          pCtx.lineTo(particles[j].x, particles[j].y);
          const alpha = 1 - (dist / 135);
          pCtx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.16})`;
          pCtx.lineWidth = 1;
          pCtx.stroke();
        }
      }
    }
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animateParticles);
  }
  animateParticles();
}

// 5. Telemetry Oscillogram Canvas
const tCanvas = document.getElementById("hero-telemetry-canvas");
if (tCanvas) {
  const tCtx = tCanvas.getContext("2d");
  let tOffset = 0;

  function resizeTelemetry() {
    tCanvas.width = tCanvas.parentElement.clientWidth;
    tCanvas.height = 125;
  }
  resizeTelemetry();
  window.addEventListener("resize", resizeTelemetry);

  function drawTelemetry() {
    tCtx.clearRect(0, 0, tCanvas.width, tCanvas.height);
    tCtx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    tCtx.lineWidth = 1;
    for (let y = 20; y < tCanvas.height; y += 30) {
      tCtx.beginPath();
      tCtx.moveTo(0, y);
      tCtx.lineTo(tCanvas.width, y);
      tCtx.stroke();
    }

    tCtx.beginPath();
    for (let x = 0; x < tCanvas.width; x += 4) {
      const y = (tCanvas.height / 2) + Math.sin((x + tOffset) * 0.04) * 22 + Math.cos((x - tOffset * 1.5) * 0.02) * 14;
      if (x === 0) tCtx.moveTo(x, y);
      else tCtx.lineTo(x, y);
    }
    tCtx.strokeStyle = "#38bdf8";
    tCtx.lineWidth = 2.5;
    tCtx.stroke();

    tCtx.beginPath();
    for (let x = 0; x < tCanvas.width; x += 4) {
      const y = (tCanvas.height / 2) + Math.sin((x - tOffset * 0.8) * 0.035) * 18 - Math.cos((x + tOffset) * 0.05) * 10;
      if (x === 0) tCtx.moveTo(x, y);
      else tCtx.lineTo(x, y);
    }
    tCtx.strokeStyle = "#c084fc";
    tCtx.lineWidth = 2;
    tCtx.stroke();

    tOffset += 2;
    requestAnimationFrame(drawTelemetry);
  }
  drawTelemetry();
}

// 6. Scroll Observer & Number Counters
const reveals = document.querySelectorAll(".reveal");
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("active");
      const counter = entry.target.querySelector(".metric-num");
      if (counter && !counter.dataset.animated) {
        animateCounter(counter);
        counter.dataset.animated = "true";
      }
    }
  });
}, { threshold: 0.15 });
reveals.forEach(el => observer.observe(el));

function animateCounter(el) {
  const target = parseFloat(el.getAttribute("data-target"));
  const suffix = el.getAttribute("data-suffix") || "";
  const isFloat = String(target).includes(".");
  const duration = 2000;
  const startTime = performance.now();

  function updateNumber(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const currentVal = target * easeOut;
    el.innerText = isFloat ? currentVal.toFixed(1) + suffix : Math.floor(currentVal) + suffix;
    if (progress < 1) requestAnimationFrame(updateNumber);
    else el.innerText = target + suffix;
  }
  requestAnimationFrame(updateNumber);
}

// 7. Interactive Terminal Logic
const terminalContent = document.getElementById("terminal-content");
const terminalData = {
  deploy: [
    { type: "prompt", text: "devops@cloudflare-wrangler:~$ wrangler deploy --env=production" },
    { type: "info", text: "==> Uploading Worker bundle (workerd runtime v2026.10)" },
    { type: "output", text: "--> Binding DurableObject: DATA (SQLite Storage Engine active)" },
    { type: "output", text: "--> Serving static assets from ./public (SPA fallback verified)" },
    { type: "success", text: "✔ Deployed successfully to https://testpaper.pages.dev" },
    { type: "info", text: "==> Worker routing: /api/auth/*, /api/papers/* (0.8ms cold start)" }
  ],
  assessment: [
    { type: "prompt", text: "developer@testpaper:~$ npx vitest run test/assessment.spec.ts" },
    { type: "output", text: "RUN  v2.1.8 /working_dir/testpaper" },
    { type: "success", text: "✓ test/assessment.spec.ts (6 tests passed)" },
    { type: "success", text: "✓ test/auth.spec.ts (11 tests passed - throttling verified)" },
    { type: "success", text: "✓ test/papers.spec.ts (8 tests passed - role access verified)" },
    { type: "info", text: "Test Files 3 passed (3) | Tests 25 passed (25) | Duration 420ms" }
  ],
  papers: [
    { type: "prompt", text: "curl -s -X GET https://testpaper.io/api/papers" },
    { type: "output", text: '{\\n  "papers": [\\n    {\\n      "id": 1,\\n      "title": "CS301: Distributed Systems Midterm",\\n      "subject": "Computer Science",\\n      "published": true\\n    }\\n  ]\\n}' },
    { type: "success", text: "✔ HTTP 200 OK (Content-Type: application/json)" }
  ],
  security: [
    { type: "prompt", text: "admin@testpaper:~$ aetheris-audit --auth=pbkdf2 --strict" },
    { type: "info", text: "==> Auditing session tokens and password hashing algorithms..." },
    { type: "success", text: "✔ PBKDF2 Iterations: 100,000 passes (Web Crypto API compliant)" },
    { type: "success", text: "✔ Login Throttling: Sliding window active (max 5 failures per 15m)" },
    { type: "success", text: "✔ Professor Gating: PROF_SIGNUP_CODE requirement verified" },
    { type: "info", text: "==> Security Posture: GRADE A+ (Zero critical findings)" }
  ]
};

function renderTerminal(tabKey) {
  if (!terminalContent) return;
  const lines = terminalData[tabKey] || terminalData.deploy;
  terminalContent.innerHTML = "";
  lines.forEach((line, index) => {
    setTimeout(() => {
      const div = document.createElement("div");
      if (line.type === "prompt") {
        div.innerHTML = `<span class="terminal-prompt">${line.text.split(":")[0]}:</span><span class="terminal-cmd">${line.text.substring(line.text.indexOf(":") + 1)}</span>`;
      } else if (line.type === "success") {
        div.className = "terminal-success";
        div.innerText = line.text;
      } else if (line.type === "info") {
        div.className = "terminal-info";
        div.innerText = line.text;
      } else {
        div.className = "terminal-output";
        div.innerText = line.text;
      }
      terminalContent.appendChild(div);
      terminalContent.scrollTop = terminalContent.scrollHeight;
    }, index * 85);
  });
}

window.switchTerminalTab = function(btn, tabKey) {
  playClickFx();
  document.querySelectorAll(".terminal-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  renderTerminal(tabKey);
};

window.runCustomTerminalCmd = function(cmd) {
  if (!terminalContent) return;
  terminalContent.innerHTML += `<div style="margin-top:0.75rem;"><span class="terminal-prompt">operator@testpaper:~$</span> <span class="terminal-cmd">${cmd}</span></div>`;
  setTimeout(() => {
    terminalContent.innerHTML += `<div class="terminal-success">✔ Process completed with code 0 (28ms)</div>`;
    terminalContent.scrollTop = terminalContent.scrollHeight;
  }, 250);
};

renderTerminal("deploy");

// 8. Pricing Toggle
let isAnnual = false;
window.toggleBilling = function() {
  isAnnual = !isAnnual;
  const toggle = document.getElementById("billing-switch");
  const monthlyLabel = document.getElementById("monthly-label");
  const annualLabel = document.getElementById("annual-label");
  const amounts = document.querySelectorAll(".amount");

  if (isAnnual) {
    toggle.classList.add("annual");
    annualLabel.style.color = "#fff";
    monthlyLabel.style.color = "var(--text-muted)";
    amounts.forEach(el => el.innerText = el.getAttribute("data-annual"));
  } else {
    toggle.classList.remove("annual");
    monthlyLabel.style.color = "#fff";
    annualLabel.style.color = "var(--text-muted)";
    amounts.forEach(el => el.innerText = el.getAttribute("data-monthly"));
  }
};

// 9. FAQ Toggle
window.toggleFaq = function(item) {
  playClickFx();
  const isActive = item.classList.contains("active");
  document.querySelectorAll(".faq-item").forEach(i => i.classList.remove("active"));
  if (!isActive) item.classList.add("active");
};

// 10. AUTH MODAL INTERACTION & API INTEGRATION
window.openAuthModal = function(mode = "login") {
  currentAuthMode = mode;
  switchAuthMode(mode);
  authModal.classList.add("open");
  document.body.style.overflow = "hidden";
  document.getElementById("modal-auth-error").textContent = "";
};

window.closeAuthModal = function() {
  authModal.classList.remove("open");
  document.body.style.overflow = "auto";
};

window.closeAuthModalOnBackdrop = function(e) {
  if (e.target === authModal) closeAuthModal();
};

window.switchAuthMode = function(mode) {
  currentAuthMode = mode;
  const title = document.getElementById("modal-title-text");
  const subtitle = document.getElementById("modal-subtitle-text");
  const nameGroup = document.getElementById("name-group");
  const roleGroup = document.getElementById("role-group");
  const profCodeGroup = document.getElementById("prof-code-group");
  const submitText = document.getElementById("submit-btn-text");
  const tabLogin = document.getElementById("tab-login-btn");
  const tabSignup = document.getElementById("tab-signup-btn");
  document.getElementById("modal-auth-error").textContent = "";

  if (mode === "signup") {
    title.innerText = "Create Account";
    subtitle.innerText = "Register to access the TestPaper Assessment Console";
    nameGroup.style.display = "block";
    roleGroup.style.display = "block";
    handleRoleChange();
    submitText.innerText = "Create Free Account";
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
  } else {
    title.innerText = "Welcome Back";
    subtitle.innerText = "Enter credentials to authenticate into the TestPaper Portal";
    nameGroup.style.display = "none";
    roleGroup.style.display = "none";
    profCodeGroup.style.display = "none";
    submitText.innerText = "Sign In to Dashboard";
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
  }
};

window.handleRoleChange = function() {
  const roleSelect = document.getElementById("modal-auth-role");
  const profCodeGroup = document.getElementById("prof-code-group");
  if (roleSelect && profCodeGroup) {
    profCodeGroup.style.display = (roleSelect.value === "prof") ? "block" : "none";
  }
};

window.togglePasswordVisibility = function() {
  const passwordInput = document.getElementById("modal-auth-password");
  passwordInput.type = (passwordInput.type === "password") ? "text" : "password";
};

window.fillDemoCredentials = function(role = "student") {
  if (role === "prof") {
    switchAuthMode("login");
    document.getElementById("modal-auth-email").value = "professor.alan@university.edu";
    document.getElementById("modal-auth-password").value = "supersecret";
  } else {
    switchAuthMode("login");
    document.getElementById("modal-auth-email").value = "student.ada@university.edu";
    document.getElementById("modal-auth-password").value = "supersecret";
  }
};

window.handleModalAuthSubmit = async function(e) {
  e.preventDefault();
  const errEl = document.getElementById("modal-auth-error");
  const submitBtn = document.getElementById("btn-modal-submit");
  errEl.textContent = "";

  const email = document.getElementById("modal-auth-email").value.trim();
  const password = document.getElementById("modal-auth-password").value;

  submitBtn.disabled = true;
  submitBtn.style.opacity = "0.7";

  try {
    if (currentAuthMode === "login") {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      currentUser = data.user;
    } else {
      const name = document.getElementById("modal-auth-name").value.trim();
      const role = document.getElementById("modal-auth-role").value;
      const profCode = document.getElementById("modal-auth-prof-code").value.trim();
      const signupBody = { email, name, password, role };
      if (role === "prof" && profCode) signupBody.prof_code = profCode;

      const data = await api("/api/auth/signup", {
        method: "POST",
        body: signupBody,
      });
      currentUser = data.user;
    }

    closeAuthModal();
    renderApp();
  } catch (err) {
    errEl.textContent = err.message || "Authentication failed";
  } finally {
    submitBtn.disabled = false;
    submitBtn.style.opacity = "1";
  }
};

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && authModal && authModal.classList.contains("open")) {
    closeAuthModal();
  }
  if ((e.key === "l" || e.key === "L") && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    if (authModal && !authModal.classList.contains("open")) {
      openAuthModal("login");
    }
  }
});

// Boot the application
boot();
