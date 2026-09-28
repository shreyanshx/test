// TestPaper SPA - vanilla ES module, no build step.
// Talks to the /api/* routes served by the Worker; all requests send the
// session cookie via credentials: "same-origin".

const appEl = document.getElementById("app");
const topbar = document.getElementById("topbar");
const whoEl = document.getElementById("who");
const logoutBtn = document.getElementById("logout-btn");

let currentUser = null;

// ---- API helpers ----

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- boot ----

async function boot() {
  try {
    const data = await api("/api/auth/me");
    currentUser = data.user;
    renderApp();
  } catch (e) {
    currentUser = null;
    renderAuth();
  }
}

logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  currentUser = null;
  renderAuth();
});

function setTopbar() {
  if (currentUser) {
    topbar.hidden = false;
    whoEl.textContent = `${currentUser.name} (${currentUser.role})`;
  } else {
    topbar.hidden = true;
    whoEl.textContent = "";
  }
}

// ---- auth screen ----

function renderAuth() {
  currentUser = null;
  setTopbar();
  clear(appEl);

  let mode = "login"; // or "signup"
  const wrap = el("div", { class: "auth-wrap" });
  appEl.appendChild(wrap);

  function draw() {
    clear(wrap);
    const tabs = el("div", { class: "tabs" }, [
      el(
        "div",
        {
          class: "tab" + (mode === "login" ? " active" : ""),
          onclick: () => {
            mode = "login";
            draw();
          },
        },
        "Log in"
      ),
      el(
        "div",
        {
          class: "tab" + (mode === "signup" ? " active" : ""),
          onclick: () => {
            mode = "signup";
            draw();
          },
        },
        "Sign up"
      ),
    ]);

    const errEl = el("p", { class: "error" });
    const card = el("div", { class: "card" });

    const emailInput = el("input", { type: "email", placeholder: "you@example.com" });
    const passInput = el("input", { type: "password", placeholder: "••••••••" });

    card.appendChild(el("h1", {}, mode === "login" ? "Welcome back" : "Create an account"));
    card.appendChild(el("label", {}, "Email"));
    card.appendChild(emailInput);

    let nameInput = null;
    let roleSelect = null;
    let profCodeInput = null;
    let profCodeLabel = null;
    if (mode === "signup") {
      nameInput = el("input", { type: "text", placeholder: "Ada Lovelace" });
      roleSelect = el("select", {}, [
        el("option", { value: "student" }, "Student"),
        el("option", { value: "prof" }, "Professor"),
      ]);
      card.appendChild(el("label", {}, "Name"));
      card.appendChild(nameInput);
      card.appendChild(el("label", {}, "Role"));
      card.appendChild(roleSelect);

      // Optional professor signup code. Only shown when "Professor" is
      // selected. If the deployment sets PROF_SIGNUP_CODE, the server requires
      // this to match; otherwise it is ignored. See README.
      profCodeLabel = el("label", {}, "Professor signup code (if required)");
      profCodeInput = el("input", {
        type: "password",
        placeholder: "Leave blank if not required",
      });
      profCodeLabel.hidden = true;
      profCodeInput.hidden = true;
      roleSelect.addEventListener("change", () => {
        const isProf = roleSelect.value === "prof";
        profCodeLabel.hidden = !isProf;
        profCodeInput.hidden = !isProf;
      });
      card.appendChild(profCodeLabel);
      card.appendChild(profCodeInput);
    }

    card.appendChild(el("label", {}, "Password"));
    card.appendChild(passInput);

    const submit = el(
      "button",
      { class: "btn", style: "margin-top:1rem;width:100%" },
      mode === "login" ? "Log in" : "Sign up"
    );

    submit.addEventListener("click", async () => {
      errEl.textContent = "";
      try {
        if (mode === "login") {
          const data = await api("/api/auth/login", {
            method: "POST",
            body: { email: emailInput.value.trim(), password: passInput.value },
          });
          currentUser = data.user;
        } else {
          const signupBody = {
            email: emailInput.value.trim(),
            name: nameInput.value.trim(),
            password: passInput.value,
            role: roleSelect.value,
          };
          if (roleSelect.value === "prof" && profCodeInput) {
            signupBody.prof_code = profCodeInput.value;
          }
          const data = await api("/api/auth/signup", {
            method: "POST",
            body: signupBody,
          });
          currentUser = data.user;
        }
        renderApp();
      } catch (e) {
        errEl.textContent = e.message;
      }
    });

    card.appendChild(submit);
    card.appendChild(errEl);
    wrap.appendChild(tabs);
    wrap.appendChild(card);
  }

  draw();
}

// ---- app root ----

function renderApp() {
  setTopbar();
  if (!currentUser) return renderAuth();
  if (currentUser.role === "prof") renderProfDashboard();
  else renderStudentDashboard();
}

function handleAuthError(e) {
  if (e && e.status === 401) {
    renderAuth();
    return true;
  }
  return false;
}

// ---- professor dashboard ----

async function renderProfDashboard() {
  clear(appEl);
  appEl.appendChild(el("h1", {}, "Professor dashboard"));

  // Create paper card
  const createCard = el("div", { class: "card" });
  createCard.appendChild(el("h2", {}, "Create a new paper"));
  const titleInput = el("input", { type: "text", placeholder: "Midterm exam" });
  const subjInput = el("input", { type: "text", placeholder: "Mathematics" });
  const descInput = el("textarea", { placeholder: "Optional description" });
  const createErr = el("p", { class: "error" });
  const createBtn = el("button", { class: "btn" }, "Create paper");
  createCard.appendChild(el("label", {}, "Title"));
  createCard.appendChild(titleInput);
  createCard.appendChild(el("label", {}, "Subject"));
  createCard.appendChild(subjInput);
  createCard.appendChild(el("label", {}, "Description"));
  createCard.appendChild(descInput);
  createCard.appendChild(el("div", { class: "actions" }, [createBtn]));
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
  listCard.appendChild(el("h2", {}, "Your papers"));
  appEl.appendChild(listCard);

  try {
    const { papers } = await api("/api/papers");
    if (!papers.length) {
      listCard.appendChild(el("p", { class: "muted" }, "No papers yet. Create one above."));
    }
    for (const p of papers) {
      const pill = el(
        "span",
        { class: "pill " + (p.published ? "pill-published" : "pill-draft") },
        p.published ? "Published" : "Draft"
      );
      const item = el("div", { class: "list-item" }, [
        el("div", {}, [
          el("div", {}, [el("strong", {}, p.title), " ", pill]),
          el(
            "div",
            { class: "meta" },
            [p.subject || "No subject", " · created ", p.created_at].join("")
          ),
        ]),
        el("div", { class: "row" }, [
          el(
            "button",
            { class: "btn btn-sm", onclick: () => renderPaperEditor(p.id) },
            "Manage"
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
    el("button", { class: "link", onclick: renderProfDashboard }, "← Back to dashboard")
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
    { class: "btn" },
    paper.published ? "Unpublish" : "Publish"
  );
  const delBtn = el("button", { class: "btn btn-danger" }, "Delete paper");
  const headErr = el("p", { class: "error" });
  head.appendChild(el("div", { class: "actions" }, [pubBtn, delBtn]));
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
    if (!confirm("Delete this paper and all its questions/submissions?")) return;
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
  qCard.appendChild(el("h2", {}, `Questions (${questions.length})`));
  for (const q of questions) {
    const block = el("div", { class: "question-block" });
    block.appendChild(el("div", {}, [el("strong", {}, `Q${q.position}. `), q.prompt]));
    if (q.options && q.options.length) {
      block.appendChild(
        el("div", { class: "meta" }, "Options: " + q.options.join(", "))
      );
    }
    block.appendChild(
      el(
        "div",
        { class: "meta" },
        `Correct: ${q.correct_answer} · ${q.points} pt(s)`
      )
    );
    qCard.appendChild(block);
  }
  appEl.appendChild(qCard);

  // Add question
  const addCard = el("div", { class: "card" });
  addCard.appendChild(el("h2", {}, "Add a question"));
  const promptInput = el("textarea", { placeholder: "What is 2 + 2?" });
  const optionsInput = el("input", {
    type: "text",
    placeholder: "Optional: comma-separated choices (e.g. 3, 4, 5)",
  });
  const answerInput = el("input", { type: "text", placeholder: "Correct answer (e.g. 4)" });
  const pointsInput = el("input", { type: "number", value: "1", min: "1" });
  const addErr = el("p", { class: "error" });
  const addBtn = el("button", { class: "btn" }, "Add question");

  addCard.appendChild(el("label", {}, "Prompt"));
  addCard.appendChild(promptInput);
  addCard.appendChild(el("label", {}, "Options (optional)"));
  addCard.appendChild(optionsInput);
  addCard.appendChild(el("label", {}, "Correct answer"));
  addCard.appendChild(answerInput);
  addCard.appendChild(el("label", {}, "Points"));
  addCard.appendChild(pointsInput);
  addCard.appendChild(el("div", { class: "actions" }, [addBtn]));
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
  subCard.appendChild(el("h2", {}, "Submissions"));
  appEl.appendChild(subCard);
  try {
    const { submissions } = await api(`/api/papers/${paperId}/submissions`);
    if (!submissions.length) {
      subCard.appendChild(el("p", { class: "muted" }, "No submissions yet."));
    } else {
      const table = el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Student"),
          el("th", {}, "Email"),
          el("th", {}, "Score"),
          el("th", {}, "Submitted"),
        ])),
      ]);
      const tbody = el("tbody");
      for (const s of submissions) {
        tbody.appendChild(
          el("tr", {}, [
            el("td", {}, s.student_name),
            el("td", {}, s.student_email),
            el("td", {}, `${s.score} / ${s.max_score}`),
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

// ---- student dashboard ----

async function renderStudentDashboard() {
  clear(appEl);
  appEl.appendChild(el("h1", {}, "Available papers"));
  const listCard = el("div", { class: "card" });
  appEl.appendChild(listCard);

  try {
    const { papers } = await api("/api/papers");
    if (!papers.length) {
      listCard.appendChild(el("p", { class: "muted" }, "No published papers available yet."));
    }
    for (const p of papers) {
      const item = el("div", { class: "list-item" }, [
        el("div", {}, [
          el("div", {}, el("strong", {}, p.title)),
          el("div", { class: "meta" }, p.subject || "No subject"),
          p.description ? el("div", { class: "meta" }, p.description) : null,
        ]),
        el("div", { class: "row" }, [
          el(
            "button",
            { class: "btn btn-sm", onclick: () => renderTakePaper(p.id) },
            "Open"
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
    el("button", { class: "link", onclick: renderStudentDashboard }, "← Back to papers")
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

  // Show an existing result if present.
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
        `Your score: ${existing.score} / ${existing.max_score}`
      )
    );
  }
  appEl.appendChild(resultBanner);

  const form = el("div", { class: "card" });
  form.appendChild(el("h2", {}, "Questions"));
  const inputs = {};
  const prevAnswers = existing ? existing.answers || {} : {};

  for (const q of questions) {
    const block = el("div", { class: "question-block" });
    block.appendChild(el("div", {}, [el("strong", {}, `Q${q.position}. `), q.prompt]));
    block.appendChild(el("div", { class: "meta" }, `${q.points} pt(s)`));

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
      const text = el("input", { type: "text", placeholder: "Your answer" });
      if (prevAnswers[q.id] !== undefined) text.value = prevAnswers[q.id];
      inputs[q.id] = { type: "text", node: text };
      block.appendChild(text);
    }
    form.appendChild(block);
  }

  const submitErr = el("p", { class: "error" });
  const submitBtn = el(
    "button",
    { class: "btn" },
    existing ? "Resubmit" : "Submit answers"
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
          `Your score: ${result.score} / ${result.max_score}`
        )
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (!handleAuthError(e)) submitErr.textContent = e.message;
    }
  });

  if (!questions.length) {
    form.appendChild(el("p", { class: "muted" }, "This paper has no questions yet."));
  } else {
    form.appendChild(el("div", { class: "actions" }, [submitBtn]));
    form.appendChild(submitErr);
  }
  appEl.appendChild(form);
}

boot();
