/* =========================================================
   Inventory Search — application logic
   Data source: Google Sheets CSV (no Apps Script)
   ========================================================= */

const SHEET_ID = "10ASGSDmZXR0sAggFxX2wHd7TYu6K8N7CT8PgcrDhmPk";

const SHEETS = [
  {
    name: "รายการพัสดุห้องชุมนุม",
    location: "ห้องชุมนุม",
    headerRow: 8
  },
  {
    name: "รายการพัสดุด้านล่าง",
    location: "ห้องเก็บของด้านล่าง",
    headerRow: 4
  }
];

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const normalize = (value) => String(value ?? "").toLocaleLowerCase("th").replace(/\s+/g, " ").trim();

let inventory = [...(window.SAMPLE_INVENTORY || [])];
let activeLocation = "ห้องชุมนุม";
let globalQuery = "";
let localQuery = "";
let activeSlide = 0;
let slideTimer = null;
let resumeSlideTimer = null;
let toastTimer;
let globalSearchHasAutoScrolled = false;
let lastFocus = null;

const heroSlides = [
  {
    kicker: "INVENTORY OVERVIEW",
    title: "รายการพัสดุทั้งหมด",
    caption: "รายการพัสดุจากทุกสถานที่จัดเก็บ",
    location: null
  },
  {
    kicker: "STORAGE LOCATION",
    title: "พัสดุห้องชุมนุม",
    caption: "รายการทั้งหมดที่จัดเก็บอยู่ในห้องชุมนุม",
    location: "ห้องชุมนุม"
  },
  {
    kicker: "STORAGE LOCATION",
    title: "ห้องเก็บของด้านล่าง",
    caption: "รายการทั้งหมดที่จัดเก็บอยู่ในห้องเก็บของด้านล่าง",
    location: "ห้องเก็บของด้านล่าง"
  }
];

function sumQuantity(variants, fallback) {
  const totals = new Map();
  variants.forEach((v) => {
    const q = String(v.quantity || "").trim();
    const m = q.match(/\d+(?:\.\d+)?/);
    if (!m) return;
    const unit = q.replace(m[0], "").trim();
    totals.set(unit, (totals.get(unit) || 0) + parseFloat(m[0]));
  });
  if (!totals.size) return fallback;
  return [...totals].map(([unit, n]) => `${Number.isInteger(n) ? n : n.toFixed(1)}${unit ? " " + unit : ""}`).join(" + ");
}

function countItems(location) {
  return inventory.filter((item) => !location || item.location === location).length;
}

let statShown = 0, statRaf;
function animateStat(el, to) {
  cancelAnimationFrame(statRaf);
  const from = statShown;
  statShown = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = to.toLocaleString("th-TH");
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min((t - t0) / 800, 1);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))).toLocaleString("th-TH");
    if (p < 1) statRaf = requestAnimationFrame(step);
  };
  statRaf = requestAnimationFrame(step);
}

function showHeroSlide(index) {
  const hero = document.querySelector(".hero");
  const next = (index + heroSlides.length) % heroSlides.length;
  const changed = next !== activeSlide;
  const dir = index >= activeSlide ? 1 : -1;
  activeSlide = next;
  const slide = heroSlides[activeSlide];
  $("heroKicker").textContent = slide.kicker;
  $("heroTitle").textContent = slide.title;
  $("heroCaption").textContent = slide.caption;
  animateStat($("heroStat"), countItems(slide.location));
  hero.style.setProperty("--slide", activeSlide);
  if (changed) {
    hero.style.setProperty("--dir", dir);
    hero.classList.remove("is-moving");
    void hero.offsetWidth;
    hero.classList.add("is-moving");
  }
  document.querySelectorAll("#heroDots button").forEach((button, i) => {
    button.classList.toggle("active", i === activeSlide);
    button.setAttribute("aria-pressed", String(i === activeSlide));
  });
}

function startAutoSlides() {
  clearInterval(slideTimer);
  slideTimer = setInterval(() => showHeroSlide(activeSlide + 1), 5000);
  document.querySelector(".hero").dataset.autoplay = "on";
}

function pauseAutoSlidesForOneMinute() {
  clearInterval(slideTimer);
  clearTimeout(resumeSlideTimer);
  document.querySelector(".hero").dataset.autoplay = "paused";
  resumeSlideTimer = setTimeout(startAutoSlides, 60000);
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function rowsToInventory(csv, sheet) {
  const rows = parseCSV(csv);
  const result = [];
  let currentCategory = "";
  let currentOrigin = "";
  let currentName = "";

  const headerIndex = rows.findIndex((row) =>
    row[3] && normalize(row[3]) === "รายการ"
  );

  const startRow = headerIndex >= 0 ? headerIndex + 1 : (sheet.headerRow || 1);

  rows.slice(startRow).forEach((row) => {
    const category = (row[0] || "").trim();
    const origin = (row[1] || "").trim();
    const number = (row[2] || "").trim();
    const name = (row[3] || "").trim();
    const size = (row[4] || "").trim();
    const quantity = (row[5] || "").trim();
    const note = (row[6] || "").trim();

    if (category && category !== "หมวดหมู่") currentCategory = category;
    if (origin && origin !== "ที่มา") currentOrigin = origin;

    if (name && name !== "รายการ") {
      currentName = name;
    }

    if (!currentName || name === "รายการ") return;
    if (!size && !quantity && !note && !name) return;

    result.push({
      location: sheet.location,
      category: currentCategory || "ไม่ระบุหมวดหมู่",
      origin: currentOrigin || "ไม่ระบุ",
      number: number || "",
      name: currentName,
      size: size || "-",
      quantity: quantity || "-",
      note
    });
  });

  return result;
}

async function fetchSheet(sheet) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet.name)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let response;
  try {
    response = await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } catch (err) {
    throw new Error(err.name === "AbortError" ? `โหลดแท็บ ${sheet.name} นานเกินไป` : `เชื่อมต่อแท็บ ${sheet.name} ไม่ได้`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`โหลดแท็บ ${sheet.name} ไม่สำเร็จ (${response.status})`);
  const csv = await response.text();
  if (csv.trim().startsWith("<!DOCTYPE html") || csv.includes("accounts.google.com")) {
    throw new Error("ชีตยังไม่เปิดสิทธิ์ให้อ่านผ่านลิงก์");
  }
  const parsed = rowsToInventory(csv, sheet);
  if (!parsed.length) throw new Error(`ไม่พบรายการในแท็บ ${sheet.name}`);
  return parsed;
}

async function loadInventory() {
  setDataStatus("กำลังเชื่อมต่อ Google Sheets...");
  try {
    const results = await Promise.allSettled(SHEETS.map(fetchSheet));
    const loaded = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (loaded.length) {
      const failedLocations = results
        .map((result, index) => result.status === "rejected" ? SHEETS[index].location : null)
        .filter(Boolean);
      for (const location of failedLocations) {
        loaded.push(...(window.SAMPLE_INVENTORY || []).filter((item) => item.location === location));
      }
      inventory = loaded;
      setDataStatus(failedLocations.length
        ? `เชื่อมต่อชีตได้บางส่วน · ใช้ข้อมูลสำรองสำหรับ ${failedLocations.join(", ")}`
        : "เชื่อมต่อ Google Sheets แล้ว · โหลดข้อมูลล่าสุดเมื่อเปิดหน้านี้");
    } else {
      throw new Error("ไม่สามารถอ่านแท็บใดได้");
    }
  } catch (error) {
    inventory = [...(window.SAMPLE_INVENTORY || [])];
    setDataStatus("ยังอ่าน Google Sheets ไม่ได้ · กำลังแสดงข้อมูลสำรองโปรดตรวจสิทธิ์การแชร์ชีต");
    console.warn("Google Sheets connection:", error);
  }
  updateLocationCounts();
  updateCategories();
  renderItems();
  showHeroSlide(activeSlide);
}

function setDataStatus(message) {
  $("resultsMeta").textContent = message;
}

function updateLocationCounts() {
  $("countRoom").textContent = `${countItems("ห้องชุมนุม")} รายการ`;
  $("countBottom").textContent = `${countItems("ห้องเก็บของด้านล่าง")} รายการ`;
}

function updateCategories() {
  const select = $("categoryFilter");
  const previousValue = select.value;
  const categories = [...new Set(
    inventory.filter((item) => item.location === activeLocation).map((item) => item.category).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "th"));

  select.innerHTML = '<option value="">ทุกหมวดหมู่</option>' + categories.map((category) =>
    `<option value="${escapeHTML(category)}">${escapeHTML(category.replace(/^หมวด/, "").trim())}</option>`
  ).join("");
  if (categories.includes(previousValue)) select.value = previousValue;
}

function itemSearchText(item) {
  return [item.name, item.category, item.location, item.origin, item.size, item.quantity, item.note, item.number]
    .map(normalize).join(" ");
}

function matchesQuery(item, query) {
  const q = normalize(query);
  return !q || itemSearchText(item).includes(q);
}

function closeSuggestions(id) {
  const box = $(id);
  if (!box) return;
  box.classList.remove("visible");
  box.innerHTML = "";
}

function renderSuggestions(inputId, boxId, query, scope) {
  const box = $(boxId);
  const q = normalize(query);
  if (!q) {
    closeSuggestions(boxId);
    return;
  }
  const pool = scope === "all" ? inventory : inventory.filter((item) => item.location === activeLocation);
  
  const seen = new Set();
  const matches = pool.filter((item) => {
    if (!itemSearchText(item).includes(q)) return false;
    const key = `${item.location}::${normalize(item.name)}`;
    return seen.has(key) ? false : (seen.add(key), true);
  }).slice(0, 6);
  if (!matches.length) {
    closeSuggestions(boxId);
    return;
  }

  box.innerHTML = matches.map((item, index) => `
    <button type="button" class="suggestion-row" role="option" data-suggestion-index="${index}">
      <span class="suggestion-name">${escapeHTML(item.name)}</span>
      <span class="suggestion-detail">สถานที่: ${escapeHTML(item.location)}${item.size && item.size !== '-' ? ` · ${escapeHTML(item.size)}` : ''}</span>
    </button>`).join("");
  
  box.classList.add("visible");
  box.querySelectorAll(".suggestion-row").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const item = matches[Number(button.dataset.suggestionIndex)];
      if (!item) return;
      if (scope === "all") {
        globalQuery = item.name;
        localQuery = "";
        $("topSearch").value = item.name;
        $("listSearch").value = "";
        $("categoryFilter").value = "";
      } else {
        localQuery = item.name;
        globalQuery = "";
        $("listSearch").value = item.name;
        $("topSearch").value = "";
        globalSearchHasAutoScrolled = false;
      }
      closeSuggestions(boxId);
      renderItems();
      document.querySelector(".items-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderItems() {
  const globalMode = normalize(globalQuery) !== "";
  const query = globalMode ? globalQuery : localQuery;
  const category = globalMode ? "" : $("categoryFilter").value;

  const filtered = inventory.filter((item) => {
    const matchesLocation = globalMode || item.location === activeLocation;
    const matchesCategory = !category || item.category === category;
    return matchesLocation && matchesCategory && matchesQuery(item, query);
  });

  const uniqueItemsMap = new Map();
  filtered.forEach((item) => {
    const key = `${item.location}::${normalize(item.name)}`;
    if (!uniqueItemsMap.has(key)) {
      uniqueItemsMap.set(key, item);
    }
  });
  const items = Array.from(uniqueItemsMap.values());

  $("listTitle").textContent = globalMode ? "ผลการค้นหาพัสดุ · ทุกสถานที่" : `รายการพัสดุ · ${activeLocation}`;
  $("itemCount").textContent = `${items.length} / ${globalMode ? inventory.length : countItems(activeLocation)} รายการ`;
  $("summary").textContent = globalMode
    ? `พบ ${items.length} รายการจากทุกสถานที่จัดเก็บ`
    : `มีรายการทั้งหมด ${countItems(activeLocation)} รายการในสถานที่นี้`;

  if (!items.length) {
    $("itemsList").innerHTML = '<div class="no-results">ไม่พบรายการที่ตรงกัน ลองเปลี่ยนคำค้นหาหรือหมวดหมู่</div>';
    return;
  }

  $("itemsList").innerHTML = items.map((item) => {
    const variants = inventory.filter((inv) => inv.location === item.location && normalize(inv.name) === normalize(item.name));
    const variantCountText = variants.length > 1 ? ` (${variants.length} รายการย่อย)` : "";
    const sizeSummary = variants.map(v => v.size).filter(Boolean).join(", ");
    
    const displayQty = variants.length > 1 ? sumQuantity(variants, variants[0].quantity || "ไม่ระบุจำนวน") : (variants[0].quantity || "ไม่ระบุจำนวน");

    return `
    <button type="button" class="item item-clickable" data-item-name="${escapeHTML(item.name)}" data-item-location="${escapeHTML(item.location)}" aria-label="ดูรายละเอียด ${escapeHTML(item.name)}">
      <span class="item-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="m4 7 8-4 8 4v10l-8 4-8-4z"/><path d="m4 7 8 4 8-4M12 11v10"/>
        </svg>
      </span>
      <span class="item-main">
        <strong>${escapeHTML(item.name)}${variantCountText}</strong>
        <small>${escapeHTML((item.category || "ไม่ระบุหมวดหมู่").replace(/^หมวด/, "").trim())}${sizeSummary ? ` · ${escapeHTML(sizeSummary)}` : ""}</small>
        <small>${globalMode ? `สถานที่: ${escapeHTML(item.location)} · ` : ""}ที่มา: ${escapeHTML(item.origin || "ไม่ระบุ")}</small>
      </span>
      <span class="qty">${escapeHTML(displayQty)}</span>
      <span class="item-chevron" aria-hidden="true">›</span>
    </button>`;
  }).join("");
} 

function openItemDetails(name, location) {
  const variants = inventory.filter((item) => item.location === location && normalize(item.name) === normalize(name));
  const first = variants[0];
  if (!first) return;
  
  const displayTotalQty = sumQuantity(variants, `${variants.length} รายการย่อย`);

  const modal = $("itemDetailModal");
  $("detailTitle").textContent = first.name;
  $("detailCategory").textContent = (first.category || "ไม่ระบุหมวดหมู่").replace(/^หมวด/, "").trim();
  $("detailLocation").textContent = first.location || "ไม่ระบุสถานที่";
  $("detailOrigin").textContent = first.origin || "ไม่ระบุ";
  $("detailTotal").textContent = displayTotalQty;

  // เพิ่มการแสดงผล "หมายเหตุ" ด้วยสีแดงเด่นชัดใน Modal
  const rows = variants.map((item) => {
    const parts = [];
    if (item.size) parts.push(`<span class="detail-tag">${escapeHTML(item.size)}</span>`);
    if (item.quantity) parts.push(`<strong>${escapeHTML(item.quantity)}</strong>`);
    
    let noteHtml = "";
    if (item.note && item.note.trim() !== "") {
      noteHtml = `<div class="detail-note">⚠️ หมายเหตุ: ${escapeHTML(item.note)}</div>`;
    }

    return `<div class="detail-variant">${parts.join(" ") || '<span>ไม่มีข้อมูลแยกย่อย</span>'}${noteHtml}</div>`;
  }).join("");

  $("detailVariantsLabel").textContent = variants.length > 1 ? "ขนาด / ลักษณะ / จำนวนแยกย่อย" : "ข้อมูลขนาดและจำนวน";
  $("detailVariants").innerHTML = rows;
  lastFocus = document.activeElement;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("detailClose").focus();
}

function closeItemDetails() {
  const modal = $("itemDetailModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

$("itemsList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-item-name]");
  if (button) openItemDetails(button.dataset.itemName, button.dataset.itemLocation);
});
$("detailClose").addEventListener("click", closeItemDetails);
$("itemDetailModal").addEventListener("click", (event) => {
  if (event.target === $("itemDetailModal")) closeItemDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeItemDetails();
    $("dropdown").classList.remove("open");
    $("menuToggle").setAttribute("aria-expanded", "false");
  }
});

function selectLocation(location, updateSlide = true) {
  activeLocation = location;
  localQuery = "";
  $("listSearch").value = "";
  closeSuggestions("listSuggestions");
  document.querySelectorAll(".location-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.location === location);
    card.setAttribute("aria-pressed", String(card.dataset.location === location));
  });
  updateCategories();
  renderItems();
  if (updateSlide) {
    const slideIndex = location === "ห้องชุมนุม" ? 1 : 2;
    showHeroSlide(slideIndex);
    pauseAutoSlidesForOneMinute();
  }
}

function searchItems(query) {
  globalQuery = query.trim();
  $("topSearch").value = query;
  closeSuggestions("topSuggestions");
  renderItems();
  if (globalQuery) document.querySelector(".items-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

function setupMenu() {
  const toggle = $("menuToggle");
  const dropdown = $("dropdown");
  toggle.addEventListener("click", () => {
    const isOpen = dropdown.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) {
      dropdown.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
  dropdown.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    dropdown.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    dropdown.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    if (button.dataset.menu === "contact") showToast("สามารถเพิ่มข้อมูลติดต่อผู้ดูแลได้ภายหลัง");
    if (button.dataset.menu === "about") showToast("ระบบค้นหาพัสดุจาก Google Sheets");
  }));
}

function setupEvents() {
  document.querySelectorAll("#heroDots button").forEach((button) => {
    button.addEventListener("click", () => {
      showHeroSlide(Number(button.dataset.slide));
      pauseAutoSlidesForOneMinute();
    });
  });
  $("heroPrev").addEventListener("click", () => {
    showHeroSlide(activeSlide - 1);
    pauseAutoSlidesForOneMinute();
  });
  $("heroNext").addEventListener("click", () => {
    showHeroSlide(activeSlide + 1);
    pauseAutoSlidesForOneMinute();
  });
  document.querySelectorAll(".location-card").forEach((button) => {
    button.addEventListener("click", () => selectLocation(button.dataset.location));
  });

  $("topSearch").addEventListener("input", () => {
    globalQuery = $("topSearch").value;
    localQuery = "";
    $("listSearch").value = "";
    $("categoryFilter").value = "";
    closeSuggestions("listSuggestions");
    renderSuggestions("topSearch", "topSuggestions", globalQuery, "all");
    renderItems();
    if (!globalQuery.trim()) globalSearchHasAutoScrolled = false;
  });
  $("topSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchItems($("topSearch").value);
    }
    if (event.key === "Escape") closeSuggestions("topSuggestions");
  });
  $("topSearch").addEventListener("focus", () => {
    if (globalQuery) renderSuggestions("topSearch", "topSuggestions", globalQuery, "all");
  });
  $("topSearch").addEventListener("blur", () => setTimeout(() => closeSuggestions("topSuggestions"), 120));

  $("listSearch").addEventListener("input", () => {
    localQuery = $("listSearch").value;
    globalQuery = "";
    $("topSearch").value = "";
    globalSearchHasAutoScrolled = false;
    closeSuggestions("topSuggestions");
    renderSuggestions("listSearch", "listSuggestions", localQuery, "room");
    renderItems();
  });
  $("listSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") closeSuggestions("listSuggestions");
    if (event.key === "Escape") closeSuggestions("listSuggestions");
  });
  $("listSearch").addEventListener("focus", () => {
    if (localQuery) renderSuggestions("listSearch", "listSuggestions", localQuery, "room");
  });
  $("listSearch").addEventListener("blur", () => setTimeout(() => closeSuggestions("listSuggestions"), 120));
  
  $("categoryFilter").addEventListener("change", () => {
    globalQuery = "";
    $("topSearch").value = "";
    localQuery = "";
    $("listSearch").value = "";
    closeSuggestions("listSuggestions");
    globalSearchHasAutoScrolled = false;
    renderItems();
  });

  let touchX = null;
  const heroEl = document.querySelector(".hero");
  heroEl.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  heroEl.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) {
      showHeroSlide(activeSlide + (dx < 0 ? 1 : -1));
      pauseAutoSlidesForOneMinute();
    }
  }, { passive: true });

  setupMenu();
  startAutoSlides();
}

setupEvents();
updateLocationCounts();
updateCategories();
renderItems();
showHeroSlide(0);
loadInventory();