// tour.js - Interactive Onboarding Tour for Patreon Archiver

const DEMO_CREATOR = {
  id: "demo_creator_tour",
  name: "Example Creator",
  avatarUrl: "../icons/icon128.png",
  membership: { isMember: true, tierName: "VIP Supporter", tierPosition: 1, tiersTotal: 3 },
  lastScanned: Date.now()
};

const DEMO_POSTS = [
  {
    id: "post_demo_1",
    title: "4K Artwork Package & Audio Commentary",
    publishedAt: new Date().toISOString(),
    text: "Thank you all for supporting! Here is the latest high-res artwork package and bonus audio commentary for this month.",
    commentCount: 14,
    thumbnail: { url: "../icons/icon128.png", sizeBytes: 154200 },
    files: [
      { filename: "Artwork_Package_4K.png", sizeBytes: 14250000, kind: "image" },
      { filename: "Creator_Commentary_Ep12.mp3", sizeBytes: 28400000, kind: "audio" }
    ]
  },
  {
    id: "post_demo_2",
    title: "Project Source Files & Cloud Archives",
    publishedAt: new Date(Date.now() - 86400000).toISOString(),
    text: "Additional project assets and project archives stored on external cloud storage providers.",
    commentCount: 8,
    files: [
      { filename: "Project_Source_Assets [Google Drive]", sizeBytes: 450000000, isCloudLink: true, tag: "Google Drive", url: "https://drive.google.com" },
      { filename: "Mega_Bonus_Archive [MEGA]", sizeBytes: 1200000000, isCloudLink: true, tag: "MEGA", url: "https://mega.nz" }
    ]
  },
  {
    id: "post_demo_3",
    title: "Exclusive Video Showcase",
    publishedAt: new Date(Date.now() - 172800000).toISOString(),
    text: "Watch our full tutorial video below.",
    commentCount: 5,
    video: { type: "embed", provider: "youtube", url: "https://www.youtube.com/watch?v=demo", filename: "Exclusive Video Showcase.mp4" },
    files: []
  }
];

const TOUR_STEPS = [
  {
    target: "#creatorList",
    title: "Creator Profiles",
    text: "All your scanned Patreon creator profiles appear here. Select any profile to manage its posts and media.",
    position: "right"
  },
  {
    target: ".toolbar",
    title: "Filters & Download Format",
    text: "Search posts, filter by cloud links, or switch between downloading individual files and packaged ZIP archives.",
    position: "bottom"
  },
  {
    target: ".post-card",
    title: "Post Contents & Downloads",
    text: "Download thumbnails, descriptions, comments, or high-res attachments with one click.",
    position: "bottom"
  },
  {
    target: "#settingsBtn",
    title: "Embedded Video Downloads",
    text: "For embedded videos (YouTube, Vimeo, etc.), open Settings to configure the optional Bridge helper.",
    position: "right"
  },
  {
    target: "#helpBtn",
    title: "Help, Community & Feedback",
    text: "Need help or have suggestions? Visit Help & About anytime to access our GitHub, Telegram community, or replay this tour.",
    position: "right"
  }
];

let currentStepIndex = 0;
let isTourActive = false;

export function isTourRunning() {
  return isTourActive;
}

export function checkAndStartOnboarding(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList) {
  try {
    chrome.storage.local.get(["tutorialCompleted"], (result) => {
      if (!result || !result.tutorialCompleted) {
        showWelcomeModal(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList);
      }
    });
  } catch (e) {
    console.warn("Could not check tutorial status:", e);
  }
}

export function showWelcomeModal(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList) {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;
  modal.style.display = "flex";

  const startBtn = document.getElementById("startTourBtn");
  const skipBtn = document.getElementById("skipTourBtn");

  const onStart = () => {
    modal.style.display = "none";
    startTour(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList);
    cleanupEvents();
  };

  const onSkip = () => {
    modal.style.display = "none";
    finishTourStorage();
    cleanupEvents();
    if (window.__pa_maybeShowOnboarding) window.__pa_maybeShowOnboarding();
  };

  const cleanupEvents = () => {
    startBtn?.removeEventListener("click", onStart);
    skipBtn?.removeEventListener("click", onSkip);
  };

  startBtn?.addEventListener("click", onStart);
  skipBtn?.addEventListener("click", onSkip);
}

export function startTour(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList) {
  isTourActive = true;
  currentStepIndex = 0;

  state.creators = [DEMO_CREATOR, ...state.creators.filter(c => c.id !== DEMO_CREATOR.id)];
  state.activeCreatorId = DEMO_CREATOR.id;
  state.posts = DEMO_POSTS;
  
  state.expanded.clear();
  DEMO_POSTS.forEach(p => state.expanded.add(p.id));

  const emptyStateEl = document.getElementById("emptyState");
  const creatorViewEl = document.getElementById("creatorView");
  if (emptyStateEl) emptyStateEl.style.display = "none";
  if (creatorViewEl) {
    creatorViewEl.style.display = "block";
    creatorViewEl.style.opacity = "1";
  }

  renderCreatorList();
  
  const creatorAvatar = document.getElementById("creatorAvatar");
  const creatorName = document.getElementById("creatorName");
  const creatorMeta = document.getElementById("creatorMeta");
  if (creatorAvatar) creatorAvatar.src = DEMO_CREATOR.avatarUrl;
  if (creatorName) creatorName.textContent = DEMO_CREATOR.name;
  if (creatorMeta) creatorMeta.textContent = `3 posts · 5 files`;

  if (typeof renderPostList === "function") {
    renderPostList();
  }

  createOverlayDOM();
  renderStep(currentStepIndex);
}

function createOverlayDOM() {
  removeOverlayDOM();

  const overlay = document.createElement("div");
  overlay.id = "tourOverlay";
  overlay.className = "tour-overlay";

  const highlight = document.createElement("div");
  highlight.id = "tourHighlight";
  highlight.className = "tour-highlight";

  const popover = document.createElement("div");
  popover.id = "tourPopover";
  popover.className = "tour-popover";

  overlay.appendChild(highlight);
  overlay.appendChild(popover);
  document.body.appendChild(overlay);
}

function renderStep(index) {
  const step = TOUR_STEPS[index];
  if (!step) return;

  const targetEl = document.querySelector(step.target);
  const highlight = document.getElementById("tourHighlight");
  const popover = document.getElementById("tourPopover");

  if (!highlight || !popover) return;

  if (targetEl) {
    const rect = targetEl.getBoundingClientRect();
    const pad = 6;
    highlight.style.top = `${rect.top - pad}px`;
    highlight.style.left = `${rect.left - pad}px`;
    highlight.style.width = `${rect.width + pad * 2}px`;
    highlight.style.height = `${rect.height + pad * 2}px`;
    highlight.style.display = "block";
    targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } else {
    highlight.style.display = "none";
  }

  const isFirst = index === 0;
  const isLast = index === TOUR_STEPS.length - 1;

  popover.innerHTML = `
    <div class="tour-popover-header">
      <span class="tour-step-badge">Step ${index + 1} of ${TOUR_STEPS.length}</span>
      <button id="tourCloseBtn" class="tour-close-btn" title="Exit Tour">&times;</button>
    </div>
    <h3 class="tour-title">${escapeHtml(step.title)}</h3>
    <p class="tour-text">${escapeHtml(step.text)}</p>
    <div class="tour-footer">
      <button id="tourPrevBtn" class="ghost-btn sm" ${isFirst ? "disabled style='opacity:0.4;'" : ""}>Back</button>
      <div class="tour-dots">
        ${TOUR_STEPS.map((_, i) => `<span class="tour-dot${i === index ? " active" : ""}"></span>`).join("")}
      </div>
      <button id="tourNextBtn" class="primary-btn sm">${isLast ? "Finish" : "Next"}</button>
    </div>
  `;

  positionPopover(popover, targetEl, step.position);

  document.getElementById("tourPrevBtn")?.addEventListener("click", prevStep);
  document.getElementById("tourNextBtn")?.addEventListener("click", nextStep);
  document.getElementById("tourCloseBtn")?.addEventListener("click", exitTour);
}

function positionPopover(popover, targetEl, preferredPos) {
  if (!targetEl) {
    popover.style.top = "50%";
    popover.style.left = "50%";
    popover.style.transform = "translate(-50%, -50%)";
    return;
  }

  const rect = targetEl.getBoundingClientRect();
  const margin = 14;

  let top = rect.bottom + margin;
  let left = rect.left;

  if (preferredPos === "right") {
    left = rect.right + margin;
    top = rect.top;
  } else if (preferredPos === "bottom") {
    top = rect.bottom + margin;
    left = rect.left + Math.max(0, (rect.width - 320) / 2);
  }

  if (left + 330 > window.innerWidth) left = window.innerWidth - 340;
  if (left < 10) left = 10;
  if (top + 220 > window.innerHeight) top = rect.top - 200;
  if (top < 10) top = 10;

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  popover.style.transform = "none";
}

function nextStep() {
  if (currentStepIndex < TOUR_STEPS.length - 1) {
    currentStepIndex++;
    renderStep(currentStepIndex);
  } else {
    exitTour();
  }
}

function prevStep() {
  if (currentStepIndex > 0) {
    currentStepIndex--;
    renderStep(currentStepIndex);
  }
}

export function exitTour() {
  const overlay = document.getElementById("tourOverlay");
  const creatorView = document.getElementById("creatorView");

  if (overlay) overlay.style.opacity = "0";
  if (creatorView) {
    creatorView.style.transition = "opacity 0.25s ease-out";
    creatorView.style.opacity = "0";
  }

  setTimeout(() => {
    removeOverlayDOM();
    isTourActive = false;
    finishTourStorage();

    if (window.__pa_loadCreators) {
      window.__pa_loadCreators().then(() => {
        if (creatorView) {
          creatorView.style.opacity = "1";
          setTimeout(() => { creatorView.style.transition = ""; }, 300);
        }
        if (window.__pa_maybeShowOnboarding) window.__pa_maybeShowOnboarding();
      });
    } else {
      window.location.reload();
    }
  }, 250);
}

function removeOverlayDOM() {
  const overlay = document.getElementById("tourOverlay");
  if (overlay) overlay.remove();
}

function finishTourStorage() {
  try {
    chrome.storage.local.set({ tutorialCompleted: true });
  } catch (e) {
    console.warn("Could not save tutorial completion flag:", e);
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
