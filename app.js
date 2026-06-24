"use strict";

const PAGE_SIZE = 8;
const ROTATE_MS = 11000;
// v10.4: timers are managed centrally to prevent stale hover/click/rotation callbacks.
const AUTO_HIGHLIGHT_AFTER_CHANGE_MS = 4200;
const CANDLE_KEY = "memorial-final-candles-v1";

const PHOTO_OVERRIDES = {};

const DESKTOP_POINTS = [
  { x: 16, y: 53.0, side: "top", size: .72 },
  { x: 28, y: 79.0, side: "bottom", size: .68 },
  { x: 40, y: 53.0, side: "top", size: .72 },
  { x: 52, y: 79.0, side: "bottom", size: .68 },
  { x: 64, y: 53.0, side: "top", size: .72 },
  { x: 76, y: 79.0, side: "bottom", size: .68 },
  { x: 88, y: 53.0, side: "top", size: .72 },
  { x: 8,  y: 79.0, side: "bottom", size: .68 },
];

const MOBILE_POINTS = [
  // Safe mobile slots: kept below the poem and above the fixed bottom controls.
  { x: 18, y: 52.5, side: "top", size: .56 },
  { x: 18, y: 76.0, side: "bottom", size: .52 },
  { x: 50, y: 52.5, side: "top", size: .56 },
  { x: 50, y: 76.0, side: "bottom", size: .52 },
  { x: 82, y: 52.5, side: "top", size: .56 },
  { x: 82, y: 76.0, side: "bottom", size: .52 },
];

const state = {
  people: [],
  filtered: [],
  visible: [],
  visibleIds: new Set(),
  pages: [],
  pageIndex: 0,
  isTransitioning: false,
  nextIndex: 0,
  slotCursor: 0,
  history: [],
  paused: false,
  timer: null,
  startDelayTimer: null,
  pendingFocusTimer: null,
  hoverResumeTimer: null,
  hoverIntentTimer: null,
  hoverIntentPersonId: null,
  openPersonId: null,
  focusPersonId: null,
  focusRelatedIds: new Set(),
  focusLocked: false,
  autoFocusIndex: 0,
  lastInteractionAt: 0,
  query: "",
  isPointerHovering: false,
  isOpeningStory: false,
  clickGuardTimer: null,
  captureClickTimer: null,
  openingResetTimer: null,
  enterTimers: [],
  storyScrollTimers: [],
  transitionToken: 0,
  interactionGuardUntil: 0,
  lastFocusedElement: null,
  storyKeydownHandler: null,
};

const els = {
  stage: document.getElementById("memory-stage"),
  layer: document.getElementById("timeline-layer"),
  search: document.getElementById("search-input"),
  prev: document.getElementById("prev-btn"),
  next: document.getElementById("next-btn"),
  pause: document.getElementById("pause-btn"),
  storyRoot: document.getElementById("story-root"),
  announcer: document.getElementById("sr-announcer"),
  pathFill: document.getElementById("path-fill"),
};

const SCALAR_TIMER_KEYS = [
  "timer",
  "startDelayTimer",
  "pendingFocusTimer",
  "hoverResumeTimer",
  "hoverIntentTimer",
  "clickGuardTimer",
  "captureClickTimer",
  "openingResetTimer",
];

function clearManagedTimer(key) {
  if (state[key]) window.clearTimeout(state[key]);
  state[key] = null;
}

function registerManagedTimer(key, timerId) {
  clearManagedTimer(key);
  state[key] = timerId;
  return timerId;
}

function clearTimerList(key) {
  const timers = Array.isArray(state[key]) ? state[key] : [];
  timers.forEach((timerId) => window.clearTimeout(timerId));
  state[key] = [];
}

function registerListTimer(key, timerId) {
  if (!Array.isArray(state[key])) state[key] = [];
  state[key].push(timerId);
  return timerId;
}

function clearInteractionTimers() {
  [
    "pendingFocusTimer",
    "hoverResumeTimer",
    "hoverIntentTimer",
    "clickGuardTimer",
    "captureClickTimer",
    "openingResetTimer",
  ].forEach(clearManagedTimer);
  state.hoverIntentPersonId = null;
}

function clearAllActiveTimers({ invalidateTransitions = true } = {}) {
  SCALAR_TIMER_KEYS.forEach(clearManagedTimer);
  clearTimerList("enterTimers");
  clearTimerList("storyScrollTimers");
  state.hoverIntentPersonId = null;

  if (invalidateTransitions) {
    state.transitionToken += 1;
    state.isTransitioning = false;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value === null || value === undefined) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.entries(value).forEach(([k, v]) => node.style.setProperty(k, v));
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  });

  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });

  return node;
}


function awaitTransition(node, property = "opacity", fallbackMs = 900, callback = () => {}) {
  if (!node) {
    callback();
    return;
  }

  let finished = false;
  let fallbackTimer = null;

  const done = () => {
    if (finished) return;
    finished = true;
    node.removeEventListener("transitionend", handler);
    clearTimeout(fallbackTimer);
    callback();
  };

  const handler = (event) => {
    if (event.target === node && event.propertyName === property) {
      done();
    }
  };

  node.addEventListener("transitionend", handler);
  fallbackTimer = window.setTimeout(done, fallbackMs);
}

function awaitTransitions(nodes, property = "opacity", fallbackMs = 950, callback = () => {}) {
  const list = Array.from(nodes || []).filter(Boolean);
  if (!list.length) {
    callback();
    return;
  }

  let remaining = list.length;
  let finished = false;
  let fallbackTimer = null;
  const handlers = new Map();

  const cleanup = () => {
    list.forEach((node) => {
      const handler = handlers.get(node);
      if (handler) node.removeEventListener("transitionend", handler);
    });
    clearTimeout(fallbackTimer);
  };

  const done = () => {
    if (finished) return;
    finished = true;
    cleanup();
    callback();
  };

  list.forEach((node) => {
    const handler = (event) => {
      if (event.target !== node || event.propertyName !== property) return;
      remaining -= 1;
      node.removeEventListener("transitionend", handler);
      handlers.delete(node);
      if (remaining <= 0) done();
    };
    handlers.set(node, handler);
    node.addEventListener("transitionend", handler);
  });

  fallbackTimer = window.setTimeout(done, fallbackMs);
}

function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0591-\u05C7]/gu, "")
    .replace(/[׳’`]/gu, "'")
    .replace(/[״“”]/gu, '"')
    .trim()
    .toLowerCase();
}

function stripMemorialSuffix(name) {
  return String(name || "").replace(/\s*ז"ל\s*$/u, "").trim();
}

function displayNameParts(name) {
  const clean = stripMemorialSuffix(name);
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts;

  const compoundSurnames = [
    ["ערבה", "אליעז"],
    ["גולדשטיין", "אלמוג"]
  ];

  for (const surname of compoundSurnames) {
    const matches = surname.every((part, index) => parts[index] === part);
    if (matches && parts.length > surname.length) {
      return [...parts.slice(surname.length), ...surname];
    }
  }

  // Default original data pattern is: surname first, given name(s) after.
  return [...parts.slice(1), parts[0]];
}

function formatDisplayName(name) {
  return displayNameParts(name).join(" ");
}

function initials(name) {
  return displayNameParts(name).slice(0, 2).map((part) => part[0]).join("") || "✦";
}

function stableHash(value) {
  let hash = 0;
  String(value || "").split("").forEach((char) => {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  });
  return Math.abs(hash);
}

function announce(message) {
  if (!els.announcer) return;
  els.announcer.textContent = "";
  setTimeout(() => { els.announcer.textContent = message; }, 20);
}

function updateUrlSafely(url, stateObject = {}) {
  if (window.location.protocol === "file:") return;
  history.pushState(stateObject, "", url);
}

function getAge(person) {
  const n = Number(person.age);
  return Number.isFinite(n) ? n : null;
}


const CUSTOM_APPEARANCE_ORDER = [
  [
    "ליבשטיין",
    "אופיר"
  ],
  [
    "צדיקביץ",
    "עומר"
  ],
  [
    "קוץ",
    "אביב"
  ],
  [
    "קוץ",
    "ליבנת"
  ],
  [
    "קוץ",
    "רותם"
  ],
  [
    "קוץ",
    "יונתן"
  ],
  [
    "קוץ",
    "יפתח"
  ],
  [
    "זוהר",
    "יניב"
  ],
  [
    "זוהר",
    "יסמין"
  ],
  [
    "זוהר",
    "קשת"
  ],
  [
    "זוהר",
    "תכלת"
  ],
  [
    "ליבשטיין",
    "ניצן"
  ],
  [
    "גולדשטיין",
    "אלמוג",
    "נדב"
  ],
  [
    "גולדשטיין",
    "אלמוג",
    "ים"
  ],
  [
    "אדמוני",
    "מיכל"
  ],
  [
    "אדמוני",
    "גיא"
  ],
  [
    "איתמרי",
    "רם"
  ],
  [
    "איתמרי",
    "לילי"
  ],
  [
    "ברדיצסקי",
    "איתי"
  ],
  [
    "ברדיצסקי",
    "הדר"
  ],
  [
    "אפשטיין",
    "בלהה"
  ],
  [
    "אפשטיין",
    "נטע"
  ],
  [
    "גורן",
    "טובה"
  ],
  [
    "גורן",
    "ארן"
  ],
  [
    "ורטהיים",
    "דורית"
  ],
  [
    "ורטהיים",
    "אביב"
  ],
  [
    "זיו",
    "איתן"
  ],
  [
    "פלג",
    "זיו",
    "תמי"
  ],
  [
    "פלד",
    "גילה"
  ],
  [
    "פלד",
    "יזהר"
  ],
  [
    "פלד",
    "דניאל"
  ],
  [
    "פלש",
    "יגאל"
  ],
  [
    "פלש",
    "תמר"
  ],
  [
    "שוורצמן",
    "דוד"
  ],
  [
    "שוורצמן",
    "אורלי"
  ],
  [
    "עידן",
    "צחי"
  ],
  [
    "עידן",
    "מעיין"
  ],
  [
    "עידן",
    "רועי"
  ],
  [
    "עידן",
    "סמדר"
  ],
  [
    "אליקים",
    "נועם"
  ],
  [
    "ערבה",
    "דקלה"
  ],
  [
    "ערבה",
    "אליעז",
    "תומר"
  ],
  [
    "רביב",
    "ניב"
  ],
  [
    "זיני",
    "ניראל"
  ],
  [
    "אלקבץ",
    "סיון"
  ],
  [
    "חסידים",
    "נאור"
  ],
  [
    "חגבי",
    "זיו"
  ],
  [
    "חגבי",
    "יהונתן"
  ],
  [
    "חגבי",
    "אליצור"
  ],
  [
    "חגבי",
    "יזהר"
  ]
];

function cleanOrderText(value) {
  return normalizeText(value)
    .replace(/ז"?ל|ז״ל/gu, "")
    .replace(/[׳'`״"]/gu, "")
    .replace(/[()\[\].,:;־\-–—]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function customOrderRank(person) {
  const text = cleanOrderText(`${person.name || ""} ${formatDisplayName(person.name || "")}`);
  const index = CUSTOM_APPEARANCE_ORDER.findIndex((tokens) =>
    tokens.every((token) => text.includes(cleanOrderText(token)))
  );
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function sortPeople(a, b) {
  const rankA = customOrderRank(a);
  const rankB = customOrderRank(b);

  if (rankA !== rankB) return rankA - rankB;

  const ageA = getAge(a);
  const ageB = getAge(b);

  if (ageA !== null && ageB !== null && ageA !== ageB) return ageA - ageB;
  if (ageA !== null && ageB === null) return -1;
  if (ageA === null && ageB !== null) return 1;

  return formatDisplayName(a.name).localeCompare(formatDisplayName(b.name), "he");
}

function points() {
  return window.matchMedia("(max-width: 900px) and (orientation: portrait)").matches ? MOBILE_POINTS : DESKTOP_POINTS;
}

function visibleCount() {
  return Math.min(points().length, PAGE_SIZE);
}

const CandleStore = {
  read() {
    try { return JSON.parse(localStorage.getItem(CANDLE_KEY) || "{}"); }
    catch { return {}; }
  },
  save(map) {
    try { localStorage.setItem(CANDLE_KEY, JSON.stringify(map)); }
    catch { /* Storage can be blocked in private/CMS contexts; candles still work visually in-session. */ }
  },
  isLit(id) {
    return Boolean(this.read()[id]);
  },
  light(id) {
    const map = this.read();
    if (!map[id]) {
      map[id] = new Date().toISOString();
      this.save(map);
    }
  },
  count(id) {
    return 12 + (stableHash(id) % 54) + (this.isLit(id) ? 1 : 0);
  }
};


const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function updatePauseButton() {
  if (!els.pause) return;

  els.pause.setAttribute("aria-pressed", String(state.paused));
  els.pause.replaceChildren(
    el("span", { class: "icon", "aria-hidden": "true", text: state.paused ? "▶" : "Ⅱ" }),
    state.paused ? "הפעלה" : "השהיה"
  );
}

function focusableWithin(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((node) => !node.hasAttribute("disabled") && !node.getAttribute("aria-hidden") && node.offsetParent !== null);
}

function handleStoryFocusTrap(event) {
  if (event.key !== "Tab" || !state.openPersonId) return;

  const overlay = els.storyRoot?.querySelector(".story-overlay");
  const focusable = focusableWithin(overlay);

  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function activateStoryAccessibility(panel) {
  if (!state.lastFocusedElement && document.activeElement instanceof HTMLElement) {
    state.lastFocusedElement = document.activeElement;
  }

  if (state.storyKeydownHandler) {
    document.removeEventListener("keydown", state.storyKeydownHandler, true);
  }

  state.storyKeydownHandler = handleStoryFocusTrap;
  document.addEventListener("keydown", state.storyKeydownHandler, true);
  document.documentElement.classList.add("story-is-open");
  document.body.classList.add("story-is-open");

  requestAnimationFrame(() => panel?.focus?.({ preventScroll: true }));
}

function deactivateStoryAccessibility({ restoreFocus = true } = {}) {
  if (state.storyKeydownHandler) {
    document.removeEventListener("keydown", state.storyKeydownHandler, true);
    state.storyKeydownHandler = null;
  }

  if (!restoreFocus) return;

  document.documentElement.classList.remove("story-is-open");
  document.body.classList.remove("story-is-open");

  const target = state.lastFocusedElement;
  state.lastFocusedElement = null;

  if (target?.isConnected) {
    target.focus({ preventScroll: true });
  }
}

function isFemale(person) {
  if (person.gender === "female") return true;
  if (person.gender === "male") return false;
  const parents = String(person.parents || "");
  const family = String(person.family || "");
  return parents.startsWith("בת") || family.startsWith("הותירה");
}

function familyLabel(person) {
  return isFemale(person) ? "הותירה אחריה" : "הותיר אחריו";
}

function cleanFamilyText(person) {
  const raw = String(person.family || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^הותירה\s+אחריה\s*/u, "")
    .replace(/^הותיר\s+אחריו\s*/u, "")
    .replace(/^הותירה\s*/u, "")
    .replace(/^הותיר\s*/u, "")
    .trim();
}

function guardLabel(person) {
  if (person.guardRole) return person.guardRole;
  if (person.isGuardMember) return "כיתת כוננות";
  return "";
}

function isGuardMember(person) {
  return Boolean(guardLabel(person));
}


function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanPersonKey(value) {
  return stripMemorialSuffix(value)
    .replace(/[״"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNameCandidates(person) {
  const parts = displayNameParts(person.name);
  if (!parts.length) return [];

  const firstParts = parts.length > 1 ? parts.slice(0, -1) : parts;
  const candidates = [
    firstParts.join(" "),
    firstParts[0],
    parts.join(" "),
  ];

  return [...new Set(candidates.filter(Boolean).map(cleanPersonKey))];
}

function lineMentionsCandidate(line, candidate) {
  const text = cleanPersonKey(line);
  const clean = cleanPersonKey(candidate);
  if (!clean || clean.length < 2) return false;

  const escaped = escapeRegex(clean);
  const boundary = "(^|[\\s,.;:־\\-()])";
  const endBoundary = "($|[\\s,.;:־\\-()])";
  const directPattern = new RegExp(`${boundary}${escaped}${endBoundary}`, "u");

  if (directPattern.test(text)) return true;

  // Hebrew lists often attach ו before the final name: "רותם ויפתח".
  if (!clean.includes(" ")) {
    const withVavPattern = new RegExp(`${boundary}ו${escaped}${endBoundary}`, "u");
    return withVavPattern.test(text);
  }

  return false;
}

function personMentionsOther(person, other) {
  const lines = relativesLines(person).join(" · ");
  if (!lines || !other) return false;

  const otherParts = displayNameParts(other.name).map(cleanPersonKey).filter(Boolean);
  const otherFullName = cleanPersonKey(formatDisplayName(other.name));
  const otherSurname = otherParts.length > 1 ? otherParts[otherParts.length - 1] : "";
  const otherGivenNames = otherParts.length > 1 ? otherParts.slice(0, -1) : otherParts;

  // Exact full-name mention is always a reliable relationship signal.
  if (otherFullName && lineMentionsCandidate(lines, otherFullName)) return true;

  // First-name-only matching creates false links between unrelated people
  // with common names. Use it only when the surname is also present, or
  // when both people share a surname.
  const personParts = displayNameParts(person.name).map(cleanPersonKey).filter(Boolean);
  const personSurname = personParts.length > 1 ? personParts[personParts.length - 1] : "";
  const hasSurnameInLine = Boolean(otherSurname && lineMentionsCandidate(lines, otherSurname));
  const sameSurname = Boolean(personSurname && otherSurname && personSurname === otherSurname);

  if (!hasSurnameInLine && !sameSurname) return false;

  return otherGivenNames.some((candidate) => lineMentionsCandidate(lines, candidate));
}

function isDirectFamilyBond(a, b) {
  if (!a || !b || a.id === b.id) return false;

  if (a.familyGroupId && b.familyGroupId && a.familyGroupId === b.familyGroupId) return true;

  // Prevent false family links between different curated family groups
  // when two unrelated people share a first name.
  if (a.familyGroupId && b.familyGroupId && a.familyGroupId !== b.familyGroupId) return false;

  if (personMentionsOther(a, b) || personMentionsOther(b, a)) return true;

  // A gentle fallback for household groups where the uploaded data used the same family name.
  const aParts = displayNameParts(a.name);
  const bParts = displayNameParts(b.name);
  const aSurname = aParts.length > 1 ? aParts[aParts.length - 1] : "";
  const bSurname = bParts.length > 1 ? bParts[bParts.length - 1] : "";
  const familyText = `${relativesLines(a).join(" ")} ${relativesLines(b).join(" ")}`;

  return Boolean(aSurname && bSurname && aSurname === bSurname && /אח|אחות|אימ|אב|בנם|בתם|בעלה|אשתו|בן זוג|בת זוג/u.test(familyText));
}

function relatedIdsFor(person) {
  const ids = new Set();

  state.people.forEach((other) => {
    if (isDirectFamilyBond(person, other)) ids.add(other.id);
  });

  return ids;
}

function visibleSignature(list) {
  return (list || []).filter(Boolean).map((person) => person.id).join("|");
}

function buildFamilyVisible(person) {
  const limit = visibleCount();
  const related = relatedIdsFor(person);
  if (!related.size) return null;

  const clusterIds = new Set([person.id, ...related]);
  const cluster = state.filtered.filter((item) => clusterIds.has(item.id));
  if (cluster.length <= 1) return null;

  const fill = [
    ...state.visible.filter(Boolean),
    ...state.filtered
  ].filter((item, index, arr) =>
    item &&
    !clusterIds.has(item.id) &&
    arr.findIndex((other) => other && other.id === item.id) === index
  );

  return [...cluster, ...fill].slice(0, limit);
}

function ensureFamilyVisible(person) {
  const related = relatedIdsFor(person);
  if (!related.size) return false;

  const clusterIds = new Set([person.id, ...related]);
  const visibleHasWholeFamily = [...clusterIds].every((id) => state.visibleIds.has(id));

  if (visibleHasWholeFamily) {
    updateFocusClasses();
    return false;
  }

  const nextVisible = buildFamilyVisible(person);
  if (!nextVisible) return false;

  const currentSignature = visibleSignature(state.visible);
  const nextSignature = visibleSignature(nextVisible);
  if (currentSignature === nextSignature) return false;

  state.visible = nextVisible;
  state.visibleIds = new Set(state.visible.filter(Boolean).map((item) => item.id));
  renderAllVisible({ initial: false, skipAutoFocus: true });
  return true;
}

function updateFocusClasses() {
  const hasFocus = Boolean(state.focusPersonId);

  els.stage?.classList.toggle("is-focus-mode", hasFocus);
  els.stage?.classList.toggle("is-focus-locked", Boolean(state.focusLocked));

  els.layer.querySelectorAll(".person-node").forEach((node) => {
    const id = node.dataset.personId;
    const focused = hasFocus && id === state.focusPersonId;
    const related = hasFocus && state.focusRelatedIds.has(id);

    node.classList.toggle("is-focused", focused);
    node.classList.toggle("is-related", related);
    node.classList.toggle("is-dimmed", hasFocus && !focused && !related);
  });
}

function focusPerson(person, locked = false, source = "manual") {
  if (!person) return;

  if (source !== "auto") {
    state.lastInteractionAt = Date.now();
  }

  state.focusPersonId = person.id;
  state.focusRelatedIds = relatedIdsFor(person);
  state.focusLocked = Boolean(locked);

  // Keep the visible cards stable during hover/click.
  // Earlier versions rearranged family groups on hover, which could move
  // the portrait under the cursor and open the wrong person.
  updateFocusClasses();
}

function clearFocusMode(force = false) {
  if (!force && (state.openPersonId || state.focusLocked)) return;

  state.focusPersonId = null;
  state.focusRelatedIds = new Set();
  state.focusLocked = false;

  updateFocusClasses();
}

function getPhotoSources(photo) {
  if (!photo) return { src: "", srcset: "" };
  return {
    src: photo,
    srcset: "",
  };
}

function createPortraitImage(person, options = {}) {
  const sources = getPhotoSources(person.photo);
  const img = el("img", {
    src: sources.src || "",
    alt: `תמונה של ${formatDisplayName(person.name)}`,
    loading: options.eager ? "eager" : "lazy",
    decoding: "async",
  });

  if (options.eager) img.setAttribute("fetchpriority", "high");

  if (sources.srcset) img.setAttribute("srcset", sources.srcset);

  // In the no-images package, image files are intentionally omitted.
  // Replace missing images with an in-DOM initials placeholder instead of
  // falling back to a missing SVG, which made Chrome display the full alt text
  // inside the portrait circle and visually overlap the name tags on mobile.
  img.onerror = () => {
    img.onerror = null;
    const fallback = el("span", {
      class: "portrait-placeholder",
      text: initials(person.name),
      "aria-hidden": "true",
    });
    img.replaceWith(fallback);
  };

  return img;
}

function enrichPerson(person, index) {
  return {
    ...person,
    id: person.id || `person-${String(index + 1).padStart(3, "0")}`,
    photo: person.photo || "",
  };
}

function updatePathProgress() {
  if (!els.pathFill) return;

  const total = Math.max(state.pages.length, 1);
  const progress = !state.pages.length ? 0 : (state.pageIndex + 1) / total;
  els.pathFill.style.strokeDashoffset = String(1 - progress);
}

function ownNameSearchText(person) {
  const values = [
    person.name,
    formatDisplayName(person.name),
    person.excelDisplayName,
    person.updatedExcelName,
  ];

  return cleanOrderText(values.filter(Boolean).join(" "));
}

function fullSearchText(person) {
  const values = [
    ownNameSearchText(person),
    person.community,
    person.age,
    person.role,
    person.guardRole,
    person.family,
    person.eventPlace,
    person.burialPlace,
    person.familyGroupTitle,
    Array.isArray(person.relativesLines) ? person.relativesLines.join(" ") : person.relativesText,
    person.storySummaryClean,
    person.storySummary,
    person.candleQuote,
  ];

  return cleanOrderText(values.filter(Boolean).join(" "));
}

function tokensMatch(text, tokens) {
  return tokens.every((token) => text.includes(token));
}

function expandWithVisibleFamily(matches) {
  const result = [];
  const ids = new Set();

  const add = (person) => {
    if (!person || ids.has(person.id)) return;
    ids.add(person.id);
    result.push(person);
  };

  matches.forEach((person) => {
    add(person);

    // If a person belongs to a direct family cluster, keep that cluster visible too.
    state.people.forEach((candidate) => {
      if (candidate.id !== person.id && isDirectFamilyBond(person, candidate)) {
        add(candidate);
      }
    });
  });

  return result;
}

function searchRank(person, tokens, query) {
  if (!tokens.length) return customOrderRank(person);

  const own = ownNameSearchText(person);
  const display = cleanOrderText(formatDisplayName(person.name));
  const exact = display === query || own === query;
  const starts = display.startsWith(query) || own.startsWith(query);
  const nameMatch = tokensMatch(own, tokens);

  if (exact) return 0;
  if (starts) return 1;
  if (nameMatch) return 2;
  return 8;
}

function sortSearchResults(list, tokens, query) {
  return [...list].sort((a, b) => {
    const rankA = searchRank(a, tokens, query);
    const rankB = searchRank(b, tokens, query);
    if (rankA !== rankB) return rankA - rankB;

    const customA = customOrderRank(a);
    const customB = customOrderRank(b);
    if (customA !== customB) return customA - customB;

    return formatDisplayName(a.name).localeCompare(formatDisplayName(b.name), "he");
  });
}

function searchHaystack(person) {
  return fullSearchText(person);
}

function applySearch(query) {
  clearAllActiveTimers();
  clearFocusMode(true);
  state.isPointerHovering = false;
  state.isOpeningStory = false;
  state.isTransitioning = false;
  state.interactionGuardUntil = 0;
  state.query = cleanOrderText(query);

  const tokens = state.query.split(/\s+/u).filter(Boolean);

  let source;
  if (!tokens.length) {
    source = [...state.people];
  } else {
    const nameMatches = state.people.filter((person) => tokensMatch(ownNameSearchText(person), tokens));
    const baseMatches = nameMatches.length
      ? nameMatches
      : state.people.filter((person) => tokensMatch(fullSearchText(person), tokens));

    source = sortSearchResults(expandWithVisibleFamily(baseMatches), tokens, state.query);
  }

  state.filtered = source;
  initializeVisible();
  renderAllVisible({ initial: true });

  stopTimer();

  // Search results should stay stable. Users can page manually if there are more results.
  if (!tokens.length) startTimer();
}

function componentForPerson(seed, people, visited) {
  const component = [];
  const queue = [seed];
  visited.add(seed.id);

  while (queue.length) {
    const current = queue.shift();
    component.push(current);

    people.forEach((candidate) => {
      if (visited.has(candidate.id)) return;
      if (isDirectFamilyBond(current, candidate)) {
        visited.add(candidate.id);
        queue.push(candidate);
      }
    });
  }

  // Do not alphabetically reshuffle search groups; keep the current filtered order.
  const order = new Map(people.map((person, index) => [person.id, index]));
  component.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

  return component;
}

function buildVisiblePages() {
  const limit = visibleCount();

  // Mobile has fewer slots. To avoid half-empty screens, keep the
  // equal cycle strict and let focus/hover bring families together when needed.
  if (limit <= 6) {
    const mobilePages = [];
    for (let i = 0; i < state.filtered.length; i += limit) {
      mobilePages.push(state.filtered.slice(i, i + limit));
    }
    return mobilePages;
  }

  const pages = [];
  const visited = new Set();

  const groups = [];
  state.filtered.forEach((person) => {
    if (visited.has(person.id)) return;
    groups.push(componentForPerson(person, state.filtered, visited));
  });

  let page = [];
  groups.forEach((group) => {
    // Families are kept together whenever the screen has enough slots.
    if (group.length > limit) {
      if (page.length) {
        pages.push(page);
        page = [];
      }

      for (let i = 0; i < group.length; i += limit) {
        pages.push(group.slice(i, i + limit));
      }
      return;
    }

    if (page.length && page.length + group.length > limit) {
      pages.push(page);
      page = [];
    }

    page.push(...group);
  });

  if (page.length) pages.push(page);
  return pages;
}

function validateEqualRotation() {
  if (!Array.isArray(state.filtered) || !state.filtered.length) return;

  const counts = new Map(state.filtered.map((person) => [person.id, 0]));
  state.pages.flat().forEach((person) => {
    if (!person?.id) return;
    counts.set(person.id, (counts.get(person.id) || 0) + 1);
  });

  const problems = [...counts.entries()].filter(([, count]) => count !== 1);
  if (problems.length) {
    // This should never affect visitors; it only helps catch future data/editing mistakes.
    console.warn("Every person should appear exactly once per full rotation cycle.", problems);
  }
}

function currentPage() {
  if (!state.pages.length) return [];
  return state.pages[state.pageIndex % state.pages.length] || [];
}

function setVisibleFromPage(page) {
  state.visible = Array.isArray(page) ? page.filter(Boolean) : [];
  state.visibleIds = new Set(state.visible.map((person) => person.id));
}

function showPage(pageIndex, options = {}) {
  if (!state.pages.length) {
    setVisibleFromPage([]);
    renderAllVisible({ initial: true });
    return;
  }

  if (state.openPersonId || state.isOpeningStory) return;
  if (Date.now() < state.interactionGuardUntil) return;

  clearAllActiveTimers({ invalidateTransitions: false });

  const nextIndex = (pageIndex + state.pages.length) % state.pages.length;
  const nextPage = state.pages[nextIndex] || [];
  const currentSignature = visibleSignature(state.visible);
  const nextSignature = visibleSignature(nextPage);

  if (currentSignature === nextSignature && !options.force) {
    state.pageIndex = nextIndex;
    startTimer();
    return;
  }

  state.pageIndex = nextIndex;
  state.isTransitioning = true;
  const transitionToken = ++state.transitionToken;

  const oldNodes = Array.from(els.layer.querySelectorAll(".person-node:not(.is-leaving)"));
  oldNodes.forEach((node) => {
    node.classList.remove("is-entering");
    node.classList.add("is-leaving");
    node.setAttribute("aria-hidden", "true");
  });

  const renderNext = () => {
    if (transitionToken !== state.transitionToken || state.openPersonId || state.isOpeningStory) return;
    setVisibleFromPage(nextPage);
    renderAllVisible({ initial: false });
    state.isTransitioning = false;
    startTimer();
  };

  if (oldNodes.length && !options.instant) {
    awaitTransitions(oldNodes, "opacity", 980, renderNext);
  } else {
    renderNext();
  }
}

function nextPage(direction = 1) {
  if (state.openPersonId || state.isOpeningStory || state.focusLocked || state.isPointerHovering || state.isTransitioning) return;
  if (Date.now() < state.interactionGuardUntil) return;
  showPage(state.pageIndex + direction);
}

function initializeVisible() {
  state.pages = buildVisiblePages();
  validateEqualRotation();
  state.pageIndex = 0;
  setVisibleFromPage(currentPage());
  state.nextIndex = 0;
  state.slotCursor = 0;
  state.autoFocusIndex = 0;
  state.history = [];
  state.isTransitioning = false;
}

function showEmptyState() {
  els.layer.replaceChildren(
    el("div", { class: "empty-state" },
      el("div", {},
        el("h2", { text: "לא נמצאו תוצאות" }),
        el("p", { text: "נסי לחפש שם פרטי/משפחה. אם אין התאמה בשם, החיפוש יבדוק גם יישוב, גיל ופרטים מתוך הסיפור." })
      )
    )
  );
}

function markNodeEntering(node) {
  if (!node) return;

  node.classList.add("is-entering");
  awaitTransition(node, "opacity", 950, () => {
    if (node.isConnected) node.classList.remove("is-entering");
  });
}

function renderAllVisible(options = {}) {
  clearTimerList("enterTimers");
  els.layer.replaceChildren();

  if (!state.filtered.length || !state.visible.length) {
    showEmptyState();
    return;
  }

  state.visible.forEach((person, index) => {
    if (!person) return;

    const node = renderPersonNode(person, index);
    node.dataset.slotIndex = String(index);
    node.classList.add("is-entering");
    els.layer.append(node);

    const delay = options.initial ? index * 75 : 90 + index * 45;
    requestAnimationFrame(() => {
      registerListTimer("enterTimers", window.setTimeout(() => {
        node.classList.add("is-visible");
        markNodeEntering(node);
      }, delay));
    });
  });

  updatePathProgress();
  updateFocusClasses();
  if (!state.openPersonId && !state.isOpeningStory) syncStoryFromQuery();
}

function personFromPointerEvent(event) {
  const node = event.target?.closest?.(".person-node");
  if (!node || !els.layer.contains(node) || node.classList.contains("is-leaving")) return null;

  const id = node.dataset.personId;
  if (!id) return null;

  return state.people.find((person) => person.id === id) || null;
}

function openPersonFromPointer(event) {
  if (event.button !== undefined && event.button !== 0) return;

  const person = personFromPointerEvent(event);
  if (!person) return;

  event.preventDefault();
  event.stopPropagation();

  state.interactionGuardUntil = Date.now() + 2400;
  handlePersonPress(person, event);
}

function pauseRotationForInteraction() {
  clearManagedTimer("hoverResumeTimer");
  stopTimer();
}

function resumeRotationAfterInteraction(delay = 900) {
  clearManagedTimer("hoverResumeTimer");
  if (state.paused || state.openPersonId || state.focusLocked || state.isPointerHovering) return;

  registerManagedTimer("hoverResumeTimer", window.setTimeout(() => {
    clearManagedTimer("hoverResumeTimer");
    if (!state.paused && !state.openPersonId && !state.focusLocked && !state.isPointerHovering) {
      startTimer();
    }
  }, delay));
}

function handlePersonHover(person) {
  if (!person || state.openPersonId) return;
  state.isPointerHovering = true;
  pauseRotationForInteraction();
  focusPerson(person, false, "hover");
}

function handlePersonLeave(person = null) {
  clearManagedTimer("hoverIntentTimer");
  state.hoverIntentPersonId = null;

  // If the pointer only passed over quickly, do nothing. This prevents dim/highlight strobing.
  if (person && !state.isPointerHovering && state.focusPersonId !== person.id) return;

  state.isPointerHovering = false;
  if (state.openPersonId || state.focusLocked) return;

  clearFocusMode();
  resumeRotationAfterInteraction(1050);
}

function handlePersonPress(person, event = null) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!person) return;
  if (state.openPersonId === person.id || state.isOpeningStory) return;

  state.isOpeningStory = true;
  state.isPointerHovering = false;
  state.isTransitioning = false;
  state.interactionGuardUntil = Date.now() + 2400;
  clearInteractionTimers();
  pauseRotationForInteraction();

  // Open exact visible person. No search/page refresh happens here.
  openStory(person);

  registerManagedTimer("clickGuardTimer", window.setTimeout(() => {
    state.isOpeningStory = false;
    clearManagedTimer("clickGuardTimer");
  }, 700));
}

function renderPersonNode(person, index) {
  const point = points()[index % points().length];
  const isTop = point.side === "top";
  const scale = point.size || .9;

  const node = el("article", {
    class: `person-node ${isTop ? "is-top" : "is-bottom"}`,
    dataset: { personId: person.id, slotIndex: String(index) },
    style: {
      right: `${point.x}%`,
      left: "auto",
      top: `${point.y}%`,
      "--node-w": `${7.7 * scale}rem`,
      "--photo-w": `${6.25 * scale}rem`,
      "--from-y": isTop ? "1rem" : "-1rem",
      "--to-y": isTop ? "1.1rem" : "-1.1rem",
      "--stem": `${2.15 * scale}rem`,
      "--stem-dir": isTop ? "to bottom" : "to top",
      "--stem-origin": isTop ? "top" : "bottom",
    },
  });

  const button = el("button", {
    class: "person-button",
    type: "button",
    "aria-label": `פתיחת הסיפור של ${formatDisplayName(person.name)}`,
    onPointerEnter: (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        clearManagedTimer("hoverIntentTimer");
        state.hoverIntentPersonId = person.id;
        registerManagedTimer("hoverIntentTimer", window.setTimeout(() => {
          if (state.hoverIntentPersonId === person.id && !state.openPersonId && !state.isOpeningStory) {
            handlePersonHover(person);
          }
        }, 85));
      }
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        clearManagedTimer("hoverIntentTimer");
        handlePersonLeave(person);
      }
    },
    onFocus: () => {
      clearManagedTimer("hoverIntentTimer");
      pauseRotationForInteraction();
      focusPerson(person, false, "keyboard");
    },
    onBlur: () => {
      clearManagedTimer("hoverIntentTimer");
      if (state.openPersonId || state.focusLocked || state.isOpeningStory) return;
      clearFocusMode();
      resumeRotationAfterInteraction(1050);
    },
    onPointerDown: () => {
      clearManagedTimer("hoverIntentTimer");
      button.classList.add("is-pressed");
    },
    onPointerUp: () => {
      button.classList.remove("is-pressed");
    },
    onPointerCancel: () => {
      button.classList.remove("is-pressed");
    },
    onClick: (event) => {
      // Keyboard activation fallback. Pointer activation is handled by the layer capture handler.
      if (event.detail === 0 && !state.openPersonId && !state.isOpeningStory) {
        handlePersonPress(person, event);
      }
    },
  });

  button.append(
    el("div", { class: "portrait-frame" },
      person.photo
        ? createPortraitImage(person, { eager: index < 3 })
        : el("span", { class: "portrait-placeholder", text: initials(person.name), "aria-hidden": "true" })
    ),
    el("span", { class: "person-name" },
      ...displayNameParts(person.name).map((part) => el("span", { text: part }))
    )
  );

  node.append(button);
  return node;
}

function scheduleFocusAfterFade(person) {
  registerManagedTimer("pendingFocusTimer", window.setTimeout(() => {
    clearManagedTimer("pendingFocusTimer");
    if (!person || state.openPersonId || state.focusLocked) return;
    if (els.layer?.querySelector(".person-node.is-entering, .person-node.is-leaving")) return;
    focusPerson(person, false, "auto");
  }, 1200));
}

function nextPersonForSequence() {
  if (!state.filtered.length) return null;
  const person = state.filtered[state.nextIndex % state.filtered.length];
  state.nextIndex = (state.nextIndex + 1) % state.filtered.length;
  return person;
}

function removeAfterTransition(node, fallbackMs = 950) {
  if (!node) return;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    node.removeEventListener("transitionend", onEnd);
    if (node.isConnected) node.remove();
    updateFocusClasses();
  };

  const onEnd = (event) => {
    if (event.target === node && event.propertyName === "opacity") cleanup();
  };

  node.addEventListener("transitionend", onEnd);
  window.setTimeout(cleanup, fallbackMs);
}

function nextAvailablePersonForSequence() {
  if (!state.filtered.length) return null;

  let guard = 0;
  while (guard < state.filtered.length) {
    const person = nextPersonForSequence();
    if (person && !state.visibleIds.has(person.id)) return person;
    guard += 1;
  }

  return null;
}

function fadeOutSlot(slotIndex) {
  const person = state.visible[slotIndex];
  if (person) {
    state.visibleIds.delete(person.id);
    state.visible[slotIndex] = null;
  }

  const oldNode = els.layer.querySelector(`.person-node[data-slot-index="${slotIndex}"]:not(.is-leaving)`);
  if (!oldNode) return;

  oldNode.classList.add("is-leaving");

  awaitTransition(oldNode, "opacity", 800, () => {
    if (oldNode.isConnected) oldNode.remove();
    updateFocusClasses();
  });
}

function replaceOne(direction = 1) {
  nextPage(direction);
}

function clearSlotNode(slotIndex) {
  const oldNode = els.layer.querySelector(`.person-node[data-slot-index="${slotIndex}"]:not(.is-leaving)`);
  if (!oldNode) return;

  oldNode.classList.add("is-leaving");
  awaitTransition(oldNode, "opacity", 800, () => {
    if (oldNode.isConnected) oldNode.remove();
    updateFocusClasses();
  });
}

function replaceNode(slotIndex, person) {
  if (!person) return;

  const oldNode = els.layer.querySelector(`.person-node[data-slot-index="${slotIndex}"]:not(.is-leaving)`);
  const newNode = renderPersonNode(person, slotIndex);
  newNode.dataset.slotIndex = String(slotIndex);

  if (!oldNode) {
    newNode.classList.add("is-entering");
    els.layer.append(newNode);
    requestAnimationFrame(() => {
      newNode.classList.add("is-visible");
      markNodeEntering(newNode);
    });
    updateFocusClasses();
    return;
  }

  oldNode.classList.add("is-leaving");

  awaitTransition(oldNode, "opacity", 800, () => {
    newNode.classList.add("is-entering");
    if (oldNode.isConnected) oldNode.replaceWith(newNode);
    requestAnimationFrame(() => {
      newNode.classList.add("is-visible");
      markNodeEntering(newNode);
      updateFocusClasses();
    });
  });
}

function autoHighlightVisible() {
  if (!state.visible.some(Boolean) || state.openPersonId || state.focusLocked) return;
  if (els.layer?.querySelector(".person-node.is-leaving, .person-node.is-entering")) return;
  if (Date.now() - state.lastInteractionAt < 7000) return;

  const candidates = state.visible.filter(Boolean);
  if (!candidates.length) return;

  const person = candidates[state.autoFocusIndex % candidates.length];
  state.autoFocusIndex = (state.autoFocusIndex + 1) % candidates.length;
  focusPerson(person, false, "auto");
}

function nextStep() {
  replaceOne(1);
}

function prevStep() {
  replaceOne(-1);
}

function relativesLines(person) {
  if (Array.isArray(person.relativesLines)) {
    return person.relativesLines.filter(Boolean);
  }
  if (person.relativesText) {
    return String(person.relativesText)
      .split(/[.;]\s*/u)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}


function cleanStoryDisplayText(value) {
  return String(value || "")
    .replace(/\[cite:[^\]]*\]/gu, "")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/\*\*/gu, "")
    .replace(/---+/gu, "\n\n")
    .replace(/חלון זיכרון אישי, מכבד וקריא[^.\n]*[.]/gu, "")
    .replace(/הפרטים מוצגים לפי המידע שנמסר[^.\n]*[.]/gu, "")
    .trim();
}

function cleanStoryParagraph(paragraph) {
  let text = String(paragraph || "").replace(/\n+/gu, " ").replace(/\s+/gu, " ").trim();

  if (/^יום הזיכרון\s*[:：]/u.test(text)) return "";

  text = text
    .replace(/^בכמה מילים\s*[:：]\s*/u, "")
    .replace(/^האדם שמאחורי השם\s*[:：]\s*/u, "");

  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text
      .replace(/^(?:הוא|היא)\s+זכור(?:ה)?\s+בזכות[^.!?\n]*?(?:,?\s*ובזכות\s+הדרך\s+שבה\s+נגע(?:ה)?\s+בלב\s+משפחת(?:ו|ה),\s+חברותי(?:ו|ה)\s+וחברי(?:ו|ה)\s+וקהילת(?:ו|ה))?[.!?]?\s*/u, "")
      .replace(/\s*,?\s*ובזכות\s+הדרך\s+שבה\s+נגע(?:ה)?\s+בלב\s+משפחת(?:ו|ה),\s+חברותי(?:ו|ה)\s+וחברי(?:ו|ה)\s+וקהילת(?:ו|ה)[.!?]?\s*/u, "")
      .trim();
  }

  text = text.replace(/\s*יום הזיכרון\s*[:：].*$/u, "").trim();
  return text.replace(/\s{2,}/gu, " ").replace(/^[\s–—-]+|[\s–—-]+$/gu, "");
}

function storyText(person) {
  const clean = cleanStoryDisplayText(person.storySummaryClean);
  const original = cleanStoryDisplayText(person.storySummary);

  if (clean) return clean;
  if (original) return original;
  return "טרם נוסף סיפור מורחב.";
}

function storyParagraphs(person) {
  const text = storyText(person)
    .replace(/\[cite:[^\]]*\]/gu, "")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/\*\*/gu, "")
    .replace(/---+/gu, "\n\n")
    .trim();

  const seen = new Set();
  const base = text
    .split(/\n{2,}/u)
    .map(cleanStoryParagraph)
    .filter(Boolean)
    .filter((part) => {
      const key = part.replace(/\s+/gu, " ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const paragraphs = [];
  base.forEach((part) => {
    if (part.length <= 520) {
      paragraphs.push(part);
      return;
    }

    const sentences = part.match(/[^.!?。\n]+[.!?。]?/gu) || [part];
    let current = "";
    sentences.forEach((sentence) => {
      const next = `${current} ${sentence}`.trim();
      if (next.length > 420 && current) {
        paragraphs.push(current.trim());
        current = sentence.trim();
      } else {
        current = next;
      }
    });
    if (current) paragraphs.push(current.trim());
  });

  return paragraphs.filter(Boolean).slice(0, 12);
}


function personPageUrl(person) {
  return `?id=${encodeURIComponent(person.id)}`;
}

function navigateToPerson(person, event = null) {
  if (!person) return;
  const resolved = state.people.find((item) => item.id === person.id) || person;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  openStory(resolved);
}

function relatedFamilyTargets(person) {
  if (!person?.familyGroupId) return [];
  return state.people.filter((candidate) =>
    candidate &&
    candidate.id !== person.id &&
    candidate.familyGroupId &&
    candidate.familyGroupId === person.familyGroupId
  );
}

function linkableNameVariants(target) {
  const parts = displayNameParts(target.name).map((part) => String(part || "").trim()).filter(Boolean);
  const full = formatDisplayName(target.name);
  const surname = parts.length > 1 ? parts[parts.length - 1] : "";
  const given = parts.length > 1 ? parts.slice(0, -1) : parts;
  const givenFull = given.join(" ").trim();
  const sourceOrder = stripMemorialSuffix(target.name);

  // Important: do NOT add the surname alone. In family cards like "קוץ רותם",
  // a surname-only match ("קוץ") could incorrectly open the first family member.
  const variants = [
    full,
    sourceOrder,
    givenFull,
    given[0],
    cleanPersonKey(full),
    cleanPersonKey(sourceOrder),
    cleanPersonKey(givenFull),
    cleanPersonKey(given[0]),
  ];

  // Link surname+given forms too, because the source data sometimes stores names surname-first.
  if (surname && given.length) variants.push(`${surname} ${givenFull}`);

  // Common spelling variant in the source/reference material.
  const withSpellingVariants = [];
  variants.forEach((value) => {
    if (!value) return;
    withSpellingVariants.push(value);
    if (String(value).includes("ליבנת")) withSpellingVariants.push(String(value).replace(/ליבנת/gu, "לבנת"));
    if (String(value).includes("לבנת")) withSpellingVariants.push(String(value).replace(/לבנת/gu, "ליבנת"));
  });

  return [...new Set(withSpellingVariants
    .map((value) => String(value || "").replace(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 2)
  )];
}

function familyLinkMap(person) {
  const map = new Map();
  const conflicts = new Set();
  const targets = relatedFamilyTargets(person);
  if (!targets.length) return map;

  const addVariant = (variant, target) => {
    const label = String(variant || "").replace(/\s+/gu, " ").trim();
    if (label.length < 2 || conflicts.has(label)) return;
    const existing = map.get(label);
    if (existing && existing.id !== target.id) {
      map.delete(label);
      conflicts.add(label);
      return;
    }
    map.set(label, target);
  };

  targets.forEach((target) => {
    linkableNameVariants(target).forEach((variant) => {
      addVariant(variant, target);
      if (!variant.startsWith("ו")) addVariant(`ו${variant}`, target);
    });
  });

  return map;
}

function createInlinePersonLink(target, text) {
  return el("a", {
    class: "inline-person-link",
    href: personPageUrl(target),
    dataset: { personId: target.id },
    onClick: (event) => navigateToPerson(target, event),
  }, text);
}

function createLinkedTextNodes(text, contextPerson) {
  const source = String(text || "");
  const map = familyLinkMap(contextPerson);
  if (!source || !map.size) return [document.createTextNode(source)];

  const entries = [...map.entries()]
    .filter(([label]) => label && label.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);

  if (!entries.length) return [document.createTextNode(source)];

  const alternatives = entries.map(([label]) => escapeRegex(label)).join("|");
  const pattern = new RegExp(`(^|[\\s,.;:־\\-()\\[\\]״\"])(` + alternatives + `)(?=$|[\\s,.;:־\\-()\\[\\]״\"])`, "gu");

  const nodes = [];
  let last = 0;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const prefix = match[1] || "";
    const label = match[2] || "";
    const start = match.index + prefix.length;
    const target = map.get(label);

    if (!target || start < last) continue;

    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    if (prefix) nodes.push(document.createTextNode(prefix));
    nodes.push(createInlinePersonLink(target, label));
    last = start + label.length;
  }

  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  return nodes.length ? nodes : [document.createTextNode(source)];
}

function createFamilyMemberLink(memberName, contextPerson) {
  const normalizedMember = cleanPersonKey(memberName);
  const target = relatedFamilyTargets(contextPerson).find((candidate) => {
    const targetNames = [
      cleanPersonKey(formatDisplayName(candidate.name)),
      cleanPersonKey(candidate.name),
      ...linkableNameVariants(candidate).map(cleanPersonKey),
    ];
    // Exact matching only. This prevents "קוץ רותם" from matching "קוץ" on Aviv.
    return targetNames.some((value) => value && value === normalizedMember);
  });

  if (!target) return el("span", { text: memberName });
  return el("a", {
    class: "family-group-member-link inline-person-link",
    href: personPageUrl(target),
    dataset: { personId: target.id },
    onClick: (event) => navigateToPerson(target, event),
  }, memberName);
}

function storyParagraphNode(paragraph, index, person = null) {
  const cleaned = cleanStoryParagraph(paragraph);
  if (!cleaned) return null;

  // Keep story text plain: family links are intentionally shown only in the family-photo section.
  return el("p", { class: `story-paragraph story-paragraph-${index + 1}`, text: cleaned });
}

function compactRelativesText(person) {
  const lines = relativesLines(person);
  if (!lines.length) return "";
  return lines.join(" · ");
}

function relationshipParts(line) {
  const text = String(line || "").trim();
  const patterns = [
    "נכדתם הבכורה של", "נכדם הבכור של", "נכדתם של", "נכדם של",
    "בנם של", "בתם של", "בנו של", "בתו של", "בנה של", "בתה של",
    "בעלה של", "אשתו של", "בן זוגה של", "בת זוגו של",
    "אביהם של", "אביהן של", "אביה של", "אביו של", "אב ל", "אבא ל",
    "אימם של", "אמן של", "אימה של", "אמו של",
    "אחיהם של", "אחותם של", "אח ל", "אחות ל",
    "נשוי ל", "נשואה ל"
  ];

  const found = patterns.find((pattern) => text.startsWith(pattern));
  if (!found) return { label: "", value: text };

  return {
    label: found,
    value: text.slice(found.length).trim(),
  };
}

function familyMemberRows(person) {
  const fm = person.familyMembers || {};
  const rows = [
    ["הורים", fm.parents || person.parents],
    ["בן/בת זוג", fm.spouse || person.spouse],
    ["ילדים", fm.children || person.children],
    ["אחים", fm.siblings || person.siblings],
    ["סבים/סבתות", fm.grandparents || person.grandparents],
  ].filter(([, value]) => String(value || "").trim());

  if (rows.length) return rows;

  return relativesLines(person).map((line) => {
    const parts = relationshipParts(line);
    return [parts.label || "משפחה", parts.value || line];
  });
}

function relativesNarrativeLines(person) {
  const direct = relativesLines(person).map((line) => String(line || "").trim()).filter(Boolean);
  if (direct.length) return direct;

  return familyMemberRows(person)
    .map(([label, value]) => {
      const cleanValue = String(value || "").trim();
      if (!cleanValue) return "";
      if (label === "הורים") return isFemale(person) ? `בתם של ${cleanValue}` : `בנם של ${cleanValue}`;
      if (label === "בן/בת זוג") return isFemale(person) ? `אשתו של ${cleanValue}` : `בעלה של ${cleanValue}`;
      if (label === "ילדים") return isFemale(person) ? `אימם של ${cleanValue}` : `אביהם של ${cleanValue}`;
      if (label === "אחים") return isFemale(person) ? `אחות ל${cleanValue}` : `אח ל${cleanValue}`;
      if (label === "סבים/סבתות") return isFemale(person) ? `נכדתם של ${cleanValue}` : `נכדם של ${cleanValue}`;
      return cleanValue;
    })
    .filter(Boolean);
}

function relativesSection(person) {
  const lines = relativesNarrativeLines(person);
  if (!lines.length) return null;

  return el("section", { class: "relatives-card relatives-card-list relatives-card-no-title", "aria-label": `קשרי משפחה של ${formatDisplayName(person.name)}` },
    el("div", { class: "relatives-list" },
      lines.map((line) => el("p", { class: "relative-line", text: line }))
    )
  );
}

function familyGroupSection(person) {
  if (!person.familyGroupId || !person.familyGroupPhoto) return null;

  const members = Array.isArray(person.familyGroupMembers)
    ? person.familyGroupMembers.filter(Boolean)
    : [];

  return el("section", { class: "family-group-card", "aria-label": `תמונת קשר משפחתי: ${person.familyGroupTitle || formatDisplayName(person.name)}` },
    el("div", { class: "family-group-image-wrap" },
      el("img", {
        class: "family-group-image",
        src: person.familyGroupPhoto,
        alt: person.familyGroupTitle || "תמונה משפחתית",
        loading: "lazy",
        decoding: "async",
      })
    ),
    el("div", { class: "family-group-copy" },
      el("span", { class: "family-group-kicker", text: person.familyGroupRelation || "קשר משפחתי" }),
      el("h3", { text: person.familyGroupTitle || "נרצחו יחד" }),
      person.familyGroupNote ? el("p", { text: person.familyGroupNote }) : null,
      members.length ? el("div", { class: "family-group-members" },
        members.map((member) => createFamilyMemberLink(member, person))
      ) : null
    )
  );
}



function candleGenderText(person) {
  return isFemale(person)
    ? { memoryFor: "לזכרה של", childOf: "בת", born: "נולדה", killed: isGuardMember(person) ? "נפלה בקרב" : "נרצחה", blessing: "יהי זכרה צרור בצרור החיים" }
    : { memoryFor: "לזכרו של", childOf: "בן", born: "נולד", killed: isGuardMember(person) ? "נפל בקרב" : "נרצח", blessing: "יהי זכרו צרור בצרור החיים" };
}

function candleFirstName(person) {
  const parts = displayNameParts(person.name || "");
  return parts[0] || "האדם האהוב";
}

function candleDisplayName(person) {
  return `${formatDisplayName(person.name)} ז״ל`;
}

function candleQuote(person) {
  const quote = String(person.candleQuote || "").trim();
  if (quote) return quote.replace(/[״”“"]$/u, "").replace(/^[״”“"]/u, "");
  const first = candleFirstName(person);
  return isFemale(person)
    ? `${first} תיזכר כאישה של אור, לב רחב, אהבה ונתינה, שהותירה אחריה חותם עמוק בלב אוהביה.`
    : `${first} ייזכר כאדם של אור, לב רחב, אהבה ונתינה, שהותיר אחריו חותם עמוק בלב אוהביו.`;
}

function candleMemoryLine(person) {
  const line = String(person.candleMemoryLine || "").trim();
  if (line) return line.replace(/[״”“"]$/u, "").replace(/^[״”“"]/u, "");
  const first = candleFirstName(person);
  return isFemale(person)
    ? `האור, הטוב והאהבה של ${first} ימשיכו להאיר בלב אוהביה לנצח.`
    : `האור, הטוב והאהבה של ${first} ימשיכו להאיר בלב אוהביו לנצח.`;
}

function candleParentLine(person) {
  const line = String(person.candleParentLine || "").trim();
  if (line) return line;
  const parents = String(person.parents || person.familyMembers?.parents || "").trim();
  if (parents) return `${candleGenderText(person).childOf} ${parents}`;
  return isFemale(person)
    ? "מוקדש באהבה לבנות ובני המשפחה ולאוהביה"
    : "מוקדש באהבה לבני המשפחה ולאוהביו";
}

function candleDatesLine(person) {
  const line = String(person.candleDatesLine || "").trim();
  if (line) return line;
  const gender = candleGenderText(person);
  const birth = String(person.birthDate || "לא צוין").trim();
  const death = String(person.deathDate || "כ״ב בתשרי תשפ״ד").trim();
  return `${gender.born}: ${birth} | ${gender.killed}: ${death}`;
}

function candlePrintData(person) {
  const gender = candleGenderText(person);
  return {
    title: String(person.candlePrintTitle || `${gender.memoryFor} ${candleDisplayName(person)}`).trim(),
    parent: candleParentLine(person),
    dates: candleDatesLine(person),
    quote: candleQuote(person),
    memory: candleMemoryLine(person),
    blessing: String(person.candlePrintBlessing || gender.blessing).trim(),
  };
}

function candlePrintLines(person) {
  const data = candlePrintData(person);
  return [data.title, data.parent, data.dates, `״${data.quote}״`, `״${data.memory}״`, data.blessing].filter(Boolean);
}

function printCandleLabel(person) {
  const data = candlePrintData(person);
  const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const printable = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(data.title || "תווית לנר זיכרון")}</title>
<style>
  @page { size: 80mm 110mm; margin: 7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #f6f1e7;
    color: #172836;
    font-family: "Noto Sans Hebrew", Arial, sans-serif;
  }
  .label {
    width: 66mm;
    min-height: 92mm;
    border: 1.3mm solid #c5a760;
    border-radius: 8mm;
    padding: 7mm 5.5mm;
    display: grid;
    align-content: center;
    gap: 3.2mm;
    text-align: center;
    background: linear-gradient(180deg, #fffdf8, #eef4f6);
    box-shadow: inset 0 0 0 .35mm rgba(255,255,255,.9);
  }
  .flame { font-size: 21pt; color: #b8862b; line-height: 1; }
  .title, .parent, .dates, .memory, .blessing { font-weight: 800; }
  .title { font-size: 15pt; line-height: 1.25; }
  .parent { font-size: 11.5pt; line-height: 1.35; }
  .dates { font-size: 10.4pt; line-height: 1.45; color: #3d5969; }
  .quote { font-size: 11.2pt; line-height: 1.45; font-style: italic; color: #233f4e; }
  .memory { font-size: 11pt; line-height: 1.5; color: #1b3442; }
  .blessing { font-size: 11.2pt; color: #253f4d; }
  .divider { height: 1px; width: 70%; margin: 1mm auto; background: linear-gradient(90deg, transparent, #c5a760, transparent); }
  @media print {
    body { background: white; }
    .label { box-shadow: none; break-inside: avoid; page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <section class="label">
    <div class="flame">🕯️</div>
    <div class="title">${escapeHtml(data.title)}</div>
    <div class="parent">${escapeHtml(data.parent)}</div>
    <div class="dates">${escapeHtml(data.dates)}</div>
    <div class="divider"></div>
    <div class="quote">״${escapeHtml(data.quote)}״</div>
    <div class="memory">״${escapeHtml(data.memory)}״</div>
    <div class="blessing">${escapeHtml(data.blessing)}</div>
  </section>
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body>
</html>`;

  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=520,height=720");
  if (!printWindow) {
    alert(candlePrintLines(person).join("\n"));
    return;
  }
  printWindow.document.open();
  printWindow.document.write(printable);
  printWindow.document.close();
}

function candlePrintSection(person) {
  const data = candlePrintData(person);
  return el("section", { class: "candle-print-card", "aria-label": `תווית לנר זיכרון עבור ${formatDisplayName(person.name)}` },
    el("div", { class: "candle-label-preview" },
      el("div", { class: "candle-print-heading-row" },
        el("span", { class: "candle-print-kicker", text: "תווית נר זיכרון (להדפסה)" })
      ),
      el("p", { class: "candle-print-help", text: "ניתן להדפיס את הטקסט הבא ולהדביק על נר זיכרון:" }),
      el("div", { class: "candle-label-lines" },
        el("strong", { text: data.title }),
        el("strong", { text: data.parent }),
        el("strong", { text: data.dates }),
        el("em", { text: `״${data.quote}״` }),
        el("strong", { text: `״${data.memory}״` }),
        el("strong", { text: data.blessing })
      )
    ),
    el("button", {
      class: "candle-print-button",
      type: "button",
      onClick: () => printCandleLabel(person),
    }, "הדפסה / שמירה ל‑PDF")
  );
}

function storyDetails(person) {
  const items = [
    ["יישוב", person.community || "לא צוין"],
    ["תאריך לידה", person.birthDate],
    ["מקום קבורה", person.burialPlace],
  ].filter(([, value]) => Boolean(value));

  if (!items.length) return null;

  return el("div", { class: "details-grid" },
    items.map(([label, value]) =>
      el("div", { class: "detail" },
        el("strong", { text: label }),
        el("span", { text: value })
      )
    )
  );
}

function openStory(person) {
  if (!person) return;

  clearAllActiveTimers();
  state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.isOpeningStory = true;
  state.interactionGuardUntil = Date.now() + 2400;
  pauseRotationForInteraction();
  state.openPersonId = person.id;

  const url = new URL(window.location.href);
  url.searchParams.set("id", person.id);
  updateUrlSafely(url, { id: person.id });

  renderStory(person);
  focusPerson(person, true, "open");
  announce(`${formatDisplayName(person.name)}. ${person.storySummary || "סיפור אישי נפתח."}`);

  registerManagedTimer("openingResetTimer", window.setTimeout(() => {
    state.isOpeningStory = false;
    clearManagedTimer("openingResetTimer");
  }, 250));
}

function closeStory() {
  clearAllActiveTimers();
  state.openPersonId = null;
  state.isOpeningStory = false;
  state.interactionGuardUntil = Date.now() + 650;
  els.storyRoot.replaceChildren();
  deactivateStoryAccessibility();
  clearFocusMode(true);

  const url = new URL(window.location.href);
  url.searchParams.delete("id");
  updateUrlSafely(url, {});

  resumeRotationAfterInteraction(900);
}

function renderStory(person) {
  clearTimerList("storyScrollTimers");
  deactivateStoryAccessibility({ restoreFocus: false });

  let paragraphs = storyParagraphs(person);
  if (!paragraphs.length) paragraphs = ["טרם נוסף סיפור מורחב."];

  const overlay = el("div", {
    class: "story-overlay story-overlay-v39",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "story-title",
  });

  const closeBtn = el("button", {
    class: "close-story close-story-v39",
    type: "button",
    "aria-label": "סגירת סיפור",
    onClick: closeStory,
  }, "×");

  const metaItems = [
    person.community || "יישוב לא צוין",
    getAge(person) !== null ? `גיל ${person.age}` : null,
    guardLabel(person),
  ].filter(Boolean);

  const heroPhoto = el("div", { class: "story-photo story-photo-v39" },
    person.photo
      ? createPortraitImage(person, { eager: true })
      : el("span", { class: "portrait-placeholder", text: initials(person.name), "aria-hidden": "true" })
  );

  const heroCopy = el("div", { class: "story-heading-v39" },
    el("h2", { id: "story-title", text: formatDisplayName(person.name) }),
    el("div", { class: "story-meta story-meta-v39" },
      metaItems.map((item) => el("span", { text: item }))
    )
  );

  const storyMain = el("section", { class: "story-main-v39", "aria-label": "תיאור הסיפור" },
    el("div", { class: "story-description story-description-v39" },
      paragraphs.map((paragraph, index) => storyParagraphNode(paragraph, index, person)).filter(Boolean)
    )
  );

  const sideItems = [relativesSection(person), storyDetails(person)].filter(Boolean);
  const sidePanel = sideItems.length
    ? el("aside", { class: "story-side-v39", "aria-label": "פרטים וקשרי משפחה" }, sideItems)
    : null;

  const familyGroup = familyGroupSection(person);
  const panel = el("article", {
    class: `story-panel story-panel-v39 ${familyGroup ? "story-panel-has-family" : "story-panel-no-family"}`,
    tabindex: "-1"
  },
    closeBtn,
    el("div", { class: "story-hero-v39" }, heroPhoto, heroCopy),
    el("div", { class: "story-body-v39" }, storyMain, sidePanel),
    familyGroup
  );

  requestAnimationFrame(() => {
    try {
      overlay.scrollTop = 0;
      panel.scrollTop = 0;
    } catch (_) {}
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeStory();
  });

  overlay.append(panel);
  els.storyRoot.replaceChildren(overlay);
  activateStoryAccessibility(panel);
  try { panel.focus({ preventScroll: true }); } catch (_) {}

  const resetStoryScroll = () => {
    try {
      overlay.scrollTop = 0;
      panel.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      panel.scrollTo({ top: 0, left: 0, behavior: "auto" });
      overlay.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch (_) {}
  };
  resetStoryScroll();
  requestAnimationFrame(resetStoryScroll);
  registerListTimer("storyScrollTimers", window.setTimeout(resetStoryScroll, 80));
  registerListTimer("storyScrollTimers", window.setTimeout(resetStoryScroll, 260));
}

function syncStoryFromQuery() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) return;

  const person = state.people.find((item) => item.id === id);
  if (person && state.openPersonId !== id) {
    clearAllActiveTimers();
    state.openPersonId = person.id;
    renderStory(person);
    focusPerson(person, true, "open");
  }
}

function startTimer() {
  clearManagedTimer("timer");

  if (state.query || state.paused || state.openPersonId || state.isOpeningStory || state.focusLocked || state.isPointerHovering || state.isTransitioning) return;

  registerManagedTimer("timer", window.setTimeout(function tick() {
    if (!state.query && !state.paused && !state.openPersonId && !state.isOpeningStory && !state.focusLocked && !state.isPointerHovering && !state.isTransitioning) {
      nextPage(1);
    }

    if (!state.query && !state.paused && !state.openPersonId && !state.isOpeningStory && !state.focusLocked && !state.isPointerHovering && !state.isTransitioning) {
      registerManagedTimer("timer", window.setTimeout(tick, ROTATE_MS));
    }
  }, ROTATE_MS));
}

function stopTimer() {
  [
    "timer",
    "startDelayTimer",
    "pendingFocusTimer",
    "hoverResumeTimer",
    "hoverIntentTimer",
    "clickGuardTimer",
    "captureClickTimer",
    "openingResetTimer",
  ].forEach(clearManagedTimer);
  state.hoverIntentPersonId = null;
}

async function loadData() {
  if (Array.isArray(window.MEMORIAL_DATA) && window.MEMORIAL_DATA.length) {
    return window.MEMORIAL_DATA;
  }

  try {
    const version = encodeURIComponent(window.MEMORIAL_BUILD_VERSION || "v10-6-compact");
    const response = await fetch(`data.json?v=${version}&_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    return [];
  }
}

function initEvents() {
  els.layer.addEventListener("pointerdown", openPersonFromPointer, true);

  els.search.addEventListener("input", debounce((event) => {
    applySearch(event.target.value);
  }, 250));

  els.next.addEventListener("click", () => {
    if (state.openPersonId || state.isOpeningStory) return;
    nextPage(1);
    startTimer();
  });

  els.prev.addEventListener("click", () => {
    if (state.openPersonId || state.isOpeningStory) return;
    nextPage(-1);
    startTimer();
  });

  els.pause.addEventListener("click", () => {
    state.paused = !state.paused;
    updatePauseButton();

    if (state.paused) stopTimer();
    else startTimer();
  });

  window.addEventListener("resize", debounce(() => {
    clearAllActiveTimers();
    initializeVisible();
    renderAllVisible({ initial: true });
    startTimer();
  }, 180));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.openPersonId) closeStory();
    if (event.key === "ArrowLeft" && !state.openPersonId) nextPage(1);
    if (event.key === "ArrowRight" && !state.openPersonId) nextPage(-1);
  });

  window.addEventListener("popstate", syncStoryFromQuery);
}

async function init() {
  updatePauseButton();
  initEvents();

  const data = await loadData();
  state.people = Array.isArray(data)
    ? data.map(enrichPerson).filter((person) => person.name)
    : [];

  applySearch("");
}

init();
