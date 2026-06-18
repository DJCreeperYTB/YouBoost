const STORAGE_KEYS = {
  profile: "youboost-profile-v1",
  creatorToken: "youboost-creator-token-v1",
  analyticsVisitor: "youboost-analytics-visitor-v1",
};

const CONFIGURED_API_BASE_URL = (
  document.querySelector('meta[name="youboost-api-base"]')?.content || ""
).replace(/\/+$/, "");
const IS_LOCAL_PREVIEW = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const API_BASE_URL =
  IS_LOCAL_PREVIEW && CONFIGURED_API_BASE_URL.includes("YOUR_PROJECT_REF")
    ? "http://127.0.0.1:8787"
    : CONFIGURED_API_BASE_URL;
const API_IS_CONFIGURED =
  Boolean(API_BASE_URL) && !API_BASE_URL.includes("YOUR_PROJECT_REF");

const CATEGORIES = [
  { name: "Animation", color: "#ef4444" },
  { name: "Art", color: "#ca8a04" },
  { name: "Cinéma", color: "#7c3aed" },
  { name: "Cuisine", color: "#16a34a" },
  { name: "Divertissement", color: "#e11d48" },
  { name: "Gaming", color: "#ea580c" },
  { name: "Musique", color: "#db2777" },
  { name: "Science", color: "#0891b2" },
  { name: "Tech", color: "#2563eb" },
  { name: "Voyage", color: "#0f766e" },
];

const DOMAIN_FUND = {
  goal: 25,
  collected: 0,
  paypalUrl: "https://paypal.me/djcreeperytb",
};

const DEFAULT_PROFILE = {
  rankingVersion: 2,
  categoryWeights: {},
  tagWeights: {},
  creatorWeights: {},
  watched: {},
  favorites: [],
  hidden: [],
};

const state = {
  videos: [],
  profile: loadProfile(),
  view: "recommended",
  sort: "recommended",
  category: "Tout",
  query: "",
  activeVideo: null,
  creator: null,
  pendingCreatorAction: null,
  studioRange: "7d",
};

const analytics = {
  visitorId: "",
  sessionId: "",
  visitId: "",
  heartbeatTimer: null,
};

const elements = {
  videoGrid: document.querySelector("#videoGrid"),
  cardTemplate: document.querySelector("#videoCardTemplate"),
  categoryRow: document.querySelector("#categoryRow"),
  sidebarCategories: document.querySelector("#sidebarCategories"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  clearSearch: document.querySelector("#clearSearch"),
  feedTitle: document.querySelector("#feedTitle"),
  sectionKicker: document.querySelector("#sectionKicker"),
  resultsSummary: document.querySelector("#resultsSummary"),
  emptyState: document.querySelector("#emptyState"),
  videoDialog: document.querySelector("#videoDialog"),
  videoPlayer: document.querySelector("#videoPlayer"),
  submitDialog: document.querySelector("#submitDialog"),
  submitForm: document.querySelector("#submitForm"),
  submitCategory: document.querySelector("#submitCategory"),
  submitStatus: document.querySelector("#submitStatus"),
  submitVideoButton: document.querySelector("#submitVideoButton"),
  submitCreatorSummary: document.querySelector("#submitCreatorSummary"),
  accountDialog: document.querySelector("#accountDialog"),
  accountLoggedOut: document.querySelector("#accountLoggedOut"),
  accountLoggedIn: document.querySelector("#accountLoggedIn"),
  creatorLoginForm: document.querySelector("#creatorLoginForm"),
  creatorLoginStatus: document.querySelector("#creatorLoginStatus"),
  plansDialog: document.querySelector("#plansDialog"),
  paymentDialog: document.querySelector("#paymentDialog"),
  studioDialog: document.querySelector("#studioDialog"),
  studioSubtitle: document.querySelector("#studioSubtitle"),
  studioStatus: document.querySelector("#studioStatus"),
  studioRangeLabel: document.querySelector("#studioRangeLabel"),
  studioClicks: document.querySelector("#studioClicks"),
  studioUniqueVisitors: document.querySelector("#studioUniqueVisitors"),
  studioAudienceShare: document.querySelector("#studioAudienceShare"),
  studioClickShare: document.querySelector("#studioClickShare"),
  studioVideoCount: document.querySelector("#studioVideoCount"),
  studioAverageClicks: document.querySelector("#studioAverageClicks"),
  studioEstimatedClicks: document.querySelector("#studioEstimatedClicks"),
  studioEstimatedVisitors: document.querySelector("#studioEstimatedVisitors"),
  studioProLift: document.querySelector("#studioProLift"),
  studioProText: document.querySelector("#studioProText"),
  studioUpgradeButton: document.querySelector("#studioUpgradeButton"),
  studioChart: document.querySelector("#studioChart"),
  studioVideoList: document.querySelector("#studioVideoList"),
  profileAvatar: document.querySelector("#profileAvatar"),
  profileAvatarFallback: document.querySelector("#profileAvatarFallback"),
  toast: document.querySelector("#toast"),
};

init();

async function init() {
  bindEvents();
  initializeAnalytics();
  renderDomainFund();
  renderCategories();
  document.querySelector("#currentYear").textContent = new Date().getFullYear();
  await restoreCreatorSession();

  const publishedVideos = await loadPublishedVideos();
  state.videos = publishedVideos.map(normalizeVideo);
  migrateRecommendationProfile();
  render();

  if (!state.videos.length) {
    elements.resultsSummary.textContent = "Le catalogue n'a pas pu être chargé.";
    elements.emptyState.hidden = false;
  }
}

function bindEvents() {
  elements.profileAvatar.addEventListener("error", () => {
    elements.profileAvatar.hidden = true;
    elements.profileAvatarFallback.hidden = false;
  });
  elements.searchForm.addEventListener("submit", (event) => event.preventDefault());
  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    elements.searchForm.classList.toggle("has-value", Boolean(state.query));
    render();
  });

  elements.clearSearch.addEventListener("click", clearSearch);

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.searchInput.focus();
    }
    if (event.key === "Escape" && document.activeElement === elements.searchInput) {
      clearSearch();
      elements.searchInput.blur();
    }
  });

  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => setSort(button.dataset.sort));
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  ["#openSubmit", "#mobileSubmit"].forEach((selector) => {
    document.querySelector(selector).addEventListener("click", openSubmitDialog);
  });
  document.querySelector("#profileButton").addEventListener("click", openAccountDialog);
  document.querySelector("#upgradeButton").addEventListener("click", openPlansDialog);
  document
    .querySelector("#accountUpgradeButton")
    .addEventListener("click", openPlansDialog);
  document
    .querySelector("#accountStudioButton")
    .addEventListener("click", openStudioDialog);
  document
    .querySelector("#creatorLogoutButton")
    .addEventListener("click", logoutCreator);
  elements.studioUpgradeButton.addEventListener("click", () => {
    if (elements.studioDialog.open) elements.studioDialog.close();
    openPlansDialog();
  });
  document
    .querySelector("#chooseProButton")
    .addEventListener("click", openPaymentWarning);
  document
    .querySelector("#continuePaypalButton")
    .addEventListener("click", continueToPaypal);
  elements.creatorLoginForm.addEventListener("submit", loginCreator);
  document.querySelectorAll("[data-studio-range]").forEach((button) => {
    button.addEventListener("click", () => selectStudioRange(button.dataset.studioRange));
  });
  document.querySelectorAll("[data-domain-fund-button]").forEach((button) => {
    button.addEventListener("click", openDomainFund);
  });

  document.querySelector("#discoverButton").addEventListener("click", () => {
    document.querySelector(".feed").scrollIntoView({ behavior: "smooth" });
  });

  document.querySelector("#resetFilters").addEventListener("click", () => {
    state.category = "Tout";
    state.query = "";
    elements.searchInput.value = "";
    elements.searchForm.classList.remove("has-value");
    setView("recommended");
  });

  document.querySelector("#resetProfile").addEventListener("click", () => {
    state.profile = structuredClone(DEFAULT_PROFILE);
    saveProfile();
    render();
    showToast("Votre profil de recommandation a été réinitialisé.");
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => closeParentDialog(button));
  });

  elements.videoDialog.addEventListener("close", stopVideo);
  elements.videoDialog.addEventListener("click", closeOnBackdrop);
  elements.submitDialog.addEventListener("click", closeOnBackdrop);
  elements.accountDialog.addEventListener("click", closeOnBackdrop);
  elements.studioDialog.addEventListener("click", closeOnBackdrop);
  elements.plansDialog.addEventListener("click", closeOnBackdrop);
  elements.paymentDialog.addEventListener("click", closeOnBackdrop);
  elements.submitForm.addEventListener("submit", submitVideoRequest);

  document.querySelector("#dialogFavorite").addEventListener("click", () => {
    if (!state.activeVideo) return;
    toggleFavorite(state.activeVideo.id);
    updateDialogFavorite();
  });

  document.querySelector("#notInterested").addEventListener("click", () => {
    if (!state.activeVideo) return;
    hideVideo(state.activeVideo.id);
    elements.videoDialog.close();
  });
}

function render() {
  const videos = getVisibleVideos();
  updateHeadings(videos.length);
  updateActiveControls();
  renderCards(videos);
  elements.emptyState.hidden = videos.length > 0;
  elements.videoGrid.hidden = videos.length === 0;
}

function getVisibleVideos() {
  const normalizedQuery = normalizeText(state.query);

  let videos = state.videos.filter((video) => !state.profile.hidden.includes(video.id));

  if (state.view === "favorites") {
    videos = videos.filter((video) => state.profile.favorites.includes(video.id));
  }

  if (state.category !== "Tout") {
    videos = videos.filter((video) => video.category === state.category);
  }

  if (normalizedQuery) {
    videos = videos.filter((video) => searchableText(video).includes(normalizedQuery));
  }

  if (state.sort === "new" || state.view === "new") {
    return videos.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }

  if (state.view === "explore") {
    return spreadProVideos(videos.sort((a, b) => discoveryScore(b) - discoveryScore(a)));
  }

  const favoriteSeeds = state.videos.filter(
    (video) =>
      state.profile.favorites.includes(video.id) &&
      !state.profile.hidden.includes(video.id),
  );
  return spreadProVideos(
    videos.sort(
      (a, b) =>
        recommendationScore(b, favoriteSeeds) - recommendationScore(a, favoriteSeeds),
    ),
  );
}

function recommendationScore(video, favoriteSeeds) {
  const categoryAffinity = state.profile.categoryWeights[video.category] || 0;
  const creatorAffinity = state.profile.creatorWeights[video.creator] || 0;
  const tagAffinity = video.tags.reduce(
    (total, tag) => total + (state.profile.tagWeights[tag] || 0),
    0,
  );
  const watchedCount = state.profile.watched[video.id] || 0;
  const freshnessDays = Math.max(0, daysSince(video.addedAt));
  const freshness = Math.max(0, 28 - freshnessDays) * 0.45;
  const smallCreatorBoost = Math.max(0, 10000 - video.subscribers) / 1500;
  const exploration = seededNumber(`${video.id}-${todayKey()}`) * 5;
  const favoriteAffinity = state.profile.favorites.includes(video.id)
    ? 0
    : favoriteSimilarityScore(video, favoriteSeeds);
  const proBoost = video.isPro ? 3.5 : 0;
  const approvedBoost = video.isApproved ? 16 : 0;
  const repeatPenalty = watchedCount * 6;

  return (
    categoryAffinity * 4 +
    creatorAffinity * 3 +
    tagAffinity * 1.8 +
    freshness +
    smallCreatorBoost +
    exploration +
    favoriteAffinity -
    repeatPenalty +
    proBoost +
    approvedBoost
  );
}

function discoveryScore(video) {
  const smallCreatorBoost = Math.max(0, 12000 - video.subscribers) / 1000;
  const freshness = Math.max(0, 45 - daysSince(video.addedAt)) * 0.2;
  const proBoost = video.isPro ? 2.5 : 0;
  return smallCreatorBoost + freshness + seededNumber(`${todayKey()}-${video.id}`) * 10 + proBoost;
}

function favoriteSimilarityScore(video, favoriteSeeds) {
  const similarities = favoriteSeeds
    .filter((favorite) => favorite.id !== video.id)
    .map((favorite) => {
      const favoriteTags = new Set(favorite.tags.map(normalizeText));
      const sharedTags = video.tags.filter((tag) => favoriteTags.has(normalizeText(tag))).length;
      return (
        (favorite.category === video.category ? 2.5 : 0) +
        (favorite.creator === video.creator ? 4 : 0) +
        Math.min(sharedTags, 3) * 1.5
      );
    })
    .filter((score) => score > 0)
    .sort((a, b) => b - a);

  return (
    (similarities[0] || 0) +
    (similarities[1] || 0) * 0.55 +
    (similarities[2] || 0) * 0.3
  );
}

function spreadProVideos(videos) {
  const result = [];
  const deferredProVideos = [];

  videos.forEach((video) => {
    if (video.isPro && result.at(-1)?.isPro) {
      deferredProVideos.push(video);
      return;
    }

    result.push(video);
    if (!video.isPro && deferredProVideos.length) {
      result.push(deferredProVideos.shift());
    }
  });

  return result.concat(deferredProVideos);
}

function renderCards(videos) {
  elements.videoGrid.replaceChildren();
  const fragment = document.createDocumentFragment();

  videos.forEach((video) => {
    const card = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    const media = card.querySelector(".video-card__media");
    const image = card.querySelector("img");
    const title = card.querySelector(".video-card__title");
    const creator = card.querySelector(".creator-name");
    const avatar = card.querySelector(".creator-avatar");
    const favoriteButton = card.querySelector(".favorite-button");
    const proBadge = card.querySelector(".pro-badge");
    const videoMeta = card.querySelector(".video-meta");

    card.dataset.videoId = video.id;
    card.classList.toggle("is-new", isWithinHours(video.addedAt, 7 * 24));
    image.src = video.thumbnail;
    image.alt = `Miniature de ${video.title}`;
    image.addEventListener("error", () => {
      image.src = createFallbackThumbnail(video);
    }, { once: true });
    title.textContent = video.title;
    creator.textContent = video.creator;
    renderChannelAvatar(avatar, video);
    avatar.style.setProperty("--avatar-color", video.accent);
    card.querySelector(".duration").textContent = video.duration;
    proBadge.hidden = !video.isPro;
    videoMeta.textContent = relativeDate(video.addedAt);
    videoMeta.hidden = !videoMeta.textContent;

    video.tags.slice(0, 3).forEach((tag) => {
      const badge = document.createElement("span");
      badge.textContent = tag;
      card.querySelector(".video-card__tags").append(badge);
    });

    const isFavorite = state.profile.favorites.includes(video.id);
    favoriteButton.classList.toggle("is-active", isFavorite);
    favoriteButton.setAttribute(
      "aria-label",
      isFavorite ? "Retirer des favoris" : "Ajouter aux favoris",
    );

    media.addEventListener("click", () => openVideo(video));
    title.addEventListener("click", () => openVideo(video));
    creator.addEventListener("click", () => searchCreator(video.creator));
    favoriteButton.addEventListener("click", () => toggleFavorite(video.id));
    fragment.append(card);
  });

  elements.videoGrid.append(fragment);
}

function renderCategories() {
  const allChip = createCategoryChip("Tout");
  elements.categoryRow.append(allChip);

  CATEGORIES.forEach((category) => {
    elements.categoryRow.append(createCategoryChip(category.name));

    const sidebarButton = document.createElement("button");
    sidebarButton.type = "button";
    sidebarButton.className = "sidebar-category";
    sidebarButton.dataset.category = category.name;
    sidebarButton.innerHTML =
      `<span class="category-dot" style="--dot-color:${category.color}"></span><span>${category.name}</span>`;
    sidebarButton.addEventListener("click", () => setCategory(category.name));
    elements.sidebarCategories.append(sidebarButton);

    const option = document.createElement("option");
    option.value = category.name;
    option.textContent = category.name;
    elements.submitCategory.append(option);
  });
}

function renderDomainFund() {
  const goal = Math.max(1, Number(DOMAIN_FUND.goal) || 1);
  const collected = Math.max(0, Number(DOMAIN_FUND.collected) || 0);
  const ratio = Math.min(1, collected / goal);
  const percent = Math.round(ratio * 100);
  const label = `${formatMoney(collected)} collectés sur ${formatMoney(goal)}`;

  document.querySelectorAll("[data-domain-fund-progress]").forEach((bar) => {
    bar.style.width = `${percent}%`;
  });
  document.querySelectorAll("[data-domain-fund-label]").forEach((labelElement) => {
    labelElement.textContent = label;
  });
  document.querySelectorAll("[data-domain-fund-percent]").forEach((percentElement) => {
    percentElement.textContent = `${percent}%`;
  });
}

function openDomainFund() {
  window.open(DOMAIN_FUND.paypalUrl, "_blank", "noopener,noreferrer");
}

function createCategoryChip(name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-chip";
  button.dataset.category = name;
  button.textContent = name;
  button.addEventListener("click", () => setCategory(name));
  return button;
}

function updateHeadings(count) {
  const labels = {
    recommended: ["Sélection personnalisée", "Pour vous"],
    new: ["Fraîchement ajoutées", "Nouveautés"],
    favorites: ["Votre collection", "Vidéos favorites"],
    explore: ["Sortez de votre bulle", "Explorer"],
  };

  const [kicker, title] = labels[state.view];
  elements.sectionKicker.textContent = state.query ? "Résultats de recherche" : kicker;
  elements.feedTitle.textContent = state.query ? `“${state.query}”` : title;

  const pieces = [`${count} vidéo${count > 1 ? "s" : ""}`];
  if (state.category !== "Tout") pieces.push(state.category);
  if (state.sort === "recommended" && state.view !== "new") {
    pieces.push("classées selon vos goûts");
  }
  elements.resultsSummary.textContent = pieces.join(" · ");
}

function updateActiveControls() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.sort === state.sort);
  });
  document.querySelectorAll("[data-category]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.category === state.category);
  });
}

function setView(view) {
  state.view = view;
  state.sort = view === "new" ? "new" : "recommended";
  render();
  document.querySelector(".feed").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setSort(sort) {
  state.sort = sort;
  if (state.view === "new" && sort === "recommended") state.view = "recommended";
  render();
}

function setCategory(category) {
  state.category = category;
  if (state.view === "favorites") state.view = "recommended";
  render();
  document.querySelector(".feed").scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearSearch() {
  state.query = "";
  elements.searchInput.value = "";
  elements.searchForm.classList.remove("has-value");
  render();
}

function searchCreator(creator) {
  state.query = creator;
  elements.searchInput.value = creator;
  elements.searchForm.classList.add("has-value");
  render();
  document.querySelector(".feed").scrollIntoView({ behavior: "smooth", block: "start" });
}

function openVideo(video) {
  state.activeVideo = video;
  trackVideoClick(video.youtubeId);
  learnFromVideo(video, 1);

  elements.videoPlayer.src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtubeId)}?autoplay=1&rel=0`;
  document.querySelector("#dialogCategory").textContent = video.category;
  document.querySelector("#dialogTitle").textContent = video.title;
  document.querySelector("#dialogCreator").textContent = video.creator;
  document.querySelector("#dialogDescription").textContent = video.description;
  const dialogAvatar = document.querySelector("#dialogAvatar");
  renderChannelAvatar(dialogAvatar, video);
  dialogAvatar.style.setProperty("--avatar-color", video.accent);
  document.querySelector("#dialogYoutubeLink").href =
    `https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeId)}`;
  updateDialogFavorite();
  elements.videoDialog.showModal();
  render();
}

function stopVideo() {
  elements.videoPlayer.src = "";
  state.activeVideo = null;
}

function updateDialogFavorite() {
  if (!state.activeVideo) return;
  const button = document.querySelector("#dialogFavorite");
  const isFavorite = state.profile.favorites.includes(state.activeVideo.id);
  button.classList.toggle("is-active", isFavorite);
  button.lastChild.textContent = isFavorite ? " Retirer des favoris" : " Ajouter aux favoris";
}

function toggleFavorite(videoId) {
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return;

  const index = state.profile.favorites.indexOf(videoId);
  if (index >= 0) {
    state.profile.favorites.splice(index, 1);
    showToast("Vidéo retirée des favoris.");
  } else {
    state.profile.favorites.push(videoId);
    showToast("Vidéo ajoutée aux favoris. Des contenus similaires seront proposés.");
  }

  saveProfile();
  render();
  updateDialogFavorite();
}

function hideVideo(videoId) {
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return;
  if (!state.profile.hidden.includes(videoId)) state.profile.hidden.push(videoId);
  learnFromVideo(video, -2, false);
  saveProfile();
  render();
  showToast("Cette vidéo ne sera plus recommandée.");
}

function learnFromVideo(video, amount, countWatch = true) {
  incrementWeight(state.profile.categoryWeights, video.category, amount);
  incrementWeight(state.profile.creatorWeights, video.creator, amount);
  video.tags.forEach((tag) => incrementWeight(state.profile.tagWeights, tag, amount * 0.65));

  if (countWatch) {
    state.profile.watched[video.id] = (state.profile.watched[video.id] || 0) + 1;
  }
  saveProfile();
}

function incrementWeight(bucket, key, amount) {
  bucket[key] = Math.max(-6, Math.min(12, (bucket[key] || 0) + amount));
}

async function restoreCreatorSession() {
  const token = localStorage.getItem(STORAGE_KEYS.creatorToken);
  if (!token || !API_IS_CONFIGURED) {
    renderCreatorAccount();
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/creator/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Session expirée.");
    state.creator = result.creator;
  } catch {
    localStorage.removeItem(STORAGE_KEYS.creatorToken);
    state.creator = null;
  }
  renderCreatorAccount();
}

function openAccountDialog() {
  state.pendingCreatorAction = null;
  elements.creatorLoginStatus.textContent = "";
  renderCreatorAccount();
  elements.accountDialog.showModal();
}

function requireCreatorFor(action) {
  if (state.creator && localStorage.getItem(STORAGE_KEYS.creatorToken)) return true;
  state.pendingCreatorAction = action;
  const messages = {
    submit: "Connectez-vous pour ajouter une vidéo.",
    upgrade: "Connectez-vous avant de choisir le forfait Pro.",
    studio: "Connectez-vous pour ouvrir YouBoost Studio.",
  };
  elements.creatorLoginStatus.textContent = messages[action] || "Connectez-vous pour continuer.";
  renderCreatorAccount();
  elements.accountDialog.showModal();
  return false;
}

async function loginCreator(event) {
  event.preventDefault();
  if (!API_IS_CONFIGURED) {
    elements.creatorLoginStatus.textContent = "Le service créateur n'est pas configuré.";
    return;
  }

  const button = elements.creatorLoginForm.querySelector('button[type="submit"]');
  const formData = new FormData(elements.creatorLoginForm);
  button.disabled = true;
  elements.creatorLoginStatus.textContent = "Connexion en cours…";

  try {
    const response = await fetch(`${API_BASE_URL}/api/creator/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: String(formData.get("code") || "").trim() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Connexion impossible.");

    localStorage.setItem(STORAGE_KEYS.creatorToken, result.token);
    state.creator = result.creator;
    elements.creatorLoginForm.reset();
    renderCreatorAccount();

    const action = state.pendingCreatorAction;
    state.pendingCreatorAction = null;
    elements.accountDialog.close();
    showToast(`Connecté en tant que ${state.creator.channelTitle || "créateur"}.`);
    if (action === "submit") openSubmitDialog();
    if (action === "upgrade") openPlansDialog();
    if (action === "studio") openStudioDialog();
  } catch (error) {
    elements.creatorLoginStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function logoutCreator() {
  localStorage.removeItem(STORAGE_KEYS.creatorToken);
  state.creator = null;
  state.pendingCreatorAction = null;
  renderCreatorAccount();
  showToast("Vous êtes déconnecté.");
}

function renderCreatorAccount() {
  const connected = Boolean(state.creator);
  elements.accountLoggedOut.hidden = connected;
  elements.accountLoggedIn.hidden = !connected;
  document.querySelector("#profileButton").classList.toggle("is-connected", connected);
  const avatarUrl = connected ? state.creator.avatarUrl : "";
  elements.profileAvatar.hidden = !avatarUrl;
  elements.profileAvatarFallback.hidden = Boolean(avatarUrl);
  if (avatarUrl) elements.profileAvatar.src = avatarUrl;
  else elements.profileAvatar.removeAttribute("src");
  if (!connected) return;

  document.querySelector("#accountChannelTitle").textContent =
    state.creator.channelTitle || "Chaîne YouTube";
  document.querySelector("#accountEmail").textContent = state.creator.email || "";
  document.querySelector("#accountPlanName").textContent =
    state.creator.isPro ? "Pro" : "Gratuit";
  document.querySelector("#accountPlanDates").textContent = state.creator.isPro
    ? `Actif jusqu’au ${formatDate(state.creator.proEndAt)}`
    : "Mise en avant naturelle";
}

function openStudioDialog() {
  if (!requireCreatorFor("studio")) return;
  if (elements.accountDialog.open) elements.accountDialog.close();
  elements.studioSubtitle.textContent =
    `Chaîne suivie : ${state.creator.channelTitle || state.creator.email || "créateur"}.`;
  elements.studioDialog.showModal();
  loadStudioStats();
}

function selectStudioRange(range) {
  state.studioRange = range;
  document.querySelectorAll("[data-studio-range]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.studioRange === range);
  });
  if (elements.studioDialog.open) loadStudioStats();
}

async function loadStudioStats() {
  if (!API_IS_CONFIGURED) {
    elements.studioStatus.textContent = "Le service Studio n'est pas encore configuré.";
    return;
  }

  const token = localStorage.getItem(STORAGE_KEYS.creatorToken);
  if (!token) {
    elements.studioStatus.textContent = "Reconnectez-vous pour ouvrir YouBoost Studio.";
    return;
  }

  elements.studioDialog.classList.add("is-loading");
  elements.studioStatus.textContent = "Chargement des statistiques…";

  try {
    const params = new URLSearchParams({ range: state.studioRange });
    const response = await fetch(`${API_BASE_URL}/api/creator/studio?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem(STORAGE_KEYS.creatorToken);
        state.creator = null;
        renderCreatorAccount();
      }
      throw new Error(result.error || "Statistiques indisponibles.");
    }
    elements.studioStatus.textContent = "";
    renderStudioStats(result);
  } catch (error) {
    elements.studioStatus.textContent = error.message;
  } finally {
    elements.studioDialog.classList.remove("is-loading");
  }
}

function renderStudioStats(data) {
  const summary = data.summary || {};
  const estimatedPro = summary.estimatedPro || {};
  const videos = Array.isArray(data.videos) ? data.videos : [];

  elements.studioRangeLabel.textContent = studioRangeLabel(data.range);
  elements.studioClicks.textContent = formatInteger(summary.totalClicks);
  elements.studioUniqueVisitors.textContent = formatInteger(summary.uniqueVisitors);
  elements.studioAudienceShare.textContent = formatPercent(summary.audienceShare);
  elements.studioClickShare.textContent = formatPercent(summary.clickShare);
  elements.studioVideoCount.textContent = formatInteger(summary.videoCount);
  elements.studioAverageClicks.textContent = formatInteger(summary.averageClicksPerVideo);
  elements.studioEstimatedClicks.textContent = formatInteger(estimatedPro.estimatedClicks);
  elements.studioEstimatedVisitors.textContent = formatInteger(
    estimatedPro.estimatedUniqueVisitors,
  );

  if (summary.isPro) {
    elements.studioProLift.textContent = "Actif";
    elements.studioProText.textContent =
      "Le bonus Pro est déjà inclus dans vos recommandations actuelles.";
    elements.studioUpgradeButton.hidden = true;
  } else {
    elements.studioProLift.textContent = `+${formatPercent(estimatedPro.liftPercent)}`;
    elements.studioProText.textContent =
      `${formatInteger(estimatedPro.extraClicks)} clics et ` +
      `${formatInteger(estimatedPro.extraUniqueVisitors)} visiteurs uniques potentiels en plus sur cette période.`;
    elements.studioUpgradeButton.hidden = false;
  }

  renderStudioChart(Array.isArray(data.clicks) ? data.clicks : [], data.range?.bucket);
  renderStudioVideos(videos);
}

function renderStudioChart(series, bucket) {
  elements.studioChart.replaceChildren();
  if (!series.length) {
    const empty = document.createElement("p");
    empty.className = "studio-empty";
    empty.textContent = "Aucun clic enregistré sur cette période.";
    elements.studioChart.append(empty);
    return;
  }

  const namespace = "http://www.w3.org/2000/svg";
  const width = 720;
  const height = 190;
  const padding = { top: 18, right: 16, bottom: 34, left: 38 };
  const values = series.map((item) => Math.max(0, Number(item.value) || 0));
  const maximum = Math.max(1, ...values);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const points = series.map((item, index) => {
    const x =
      padding.left + (series.length === 1 ? plotWidth / 2 : (plotWidth * index) / (series.length - 1));
    const y = padding.top + plotHeight - (values[index] / maximum) * plotHeight;
    return { x, y, item, value: values[index] };
  });

  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Courbe des clics YouBoost Studio");

  for (let index = 0; index <= 3; index += 1) {
    const y = padding.top + (plotHeight * index) / 3;
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "studio-grid-line");
    svg.append(line);
  }

  const area = document.createElementNS(namespace, "path");
  area.setAttribute(
    "d",
    [
      `M ${points[0].x} ${padding.top + plotHeight}`,
      ...points.map((point) => `L ${point.x} ${point.y}`),
      `L ${points.at(-1).x} ${padding.top + plotHeight}`,
      "Z",
    ].join(" "),
  );
  area.setAttribute("class", "studio-chart-area");
  svg.append(area);

  const line = document.createElementNS(namespace, "polyline");
  line.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
  line.setAttribute("class", "studio-chart-line");
  svg.append(line);

  points.forEach((point) => {
    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("cx", point.x);
    circle.setAttribute("cy", point.y);
    circle.setAttribute("r", 3.5);
    circle.setAttribute("class", "studio-chart-point");
    const title = document.createElementNS(namespace, "title");
    title.textContent = `${formatStudioChartDate(point.item.at, bucket)} : ${formatInteger(point.value)} clics`;
    circle.append(title);
    svg.append(circle);
  });

  [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])].forEach((index) => {
    const point = points[index];
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", point.x);
    label.setAttribute("y", height - 12);
    label.setAttribute("text-anchor", index === 0 ? "start" : index === series.length - 1 ? "end" : "middle");
    label.setAttribute("class", "studio-axis-label");
    label.textContent = formatStudioChartDate(point.item.at, bucket);
    svg.append(label);
  });

  elements.studioChart.append(svg);
}

function renderStudioVideos(videos) {
  elements.studioVideoList.replaceChildren();
  if (!videos.length) {
    const empty = document.createElement("p");
    empty.className = "studio-empty";
    empty.textContent = "Aucune vidéo publiée pour cette chaîne.";
    elements.studioVideoList.append(empty);
    return;
  }

  videos.forEach((video) => {
    const item = document.createElement("article");
    item.className = "studio-video-item";

    const image = document.createElement("img");
    image.src =
      video.thumbnail ||
      `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeId)}/hqdefault.jpg`;
    image.alt = "";

    const content = document.createElement("div");
    content.className = "studio-video-item__content";
    const title = document.createElement("strong");
    title.textContent = video.title || "Vidéo YouTube";
    const meta = document.createElement("span");
    meta.textContent = `${formatInteger(video.uniqueVisitors)} visiteurs uniques`;
    content.append(title, meta);

    const metrics = document.createElement("div");
    metrics.className = "studio-video-item__metrics";
    const clicks = document.createElement("strong");
    clicks.textContent = formatInteger(video.clicks);
    const clicksLabel = document.createElement("span");
    clicksLabel.textContent = Number(video.clicks) === 1 ? "clic" : "clics";
    const estimate = document.createElement("small");
    estimate.textContent = `Pro estimé : ${formatInteger(video.estimatedProClicks)} clics`;
    metrics.append(clicks, clicksLabel, estimate);

    item.append(image, content, metrics);
    elements.studioVideoList.append(item);
  });
}

function openPlansDialog() {
  if (!requireCreatorFor("upgrade")) return;
  if (elements.accountDialog.open) elements.accountDialog.close();
  if (elements.studioDialog.open) elements.studioDialog.close();
  elements.plansDialog.showModal();
}

function openPaymentWarning() {
  if (!requireCreatorFor("upgrade")) return;
  elements.plansDialog.close();
  elements.paymentDialog.showModal();
}

function continueToPaypal() {
  if (!requireCreatorFor("upgrade")) return;
  elements.paymentDialog.close();
  window.open("https://paypal.me/djcreeperytb", "_blank", "noopener,noreferrer");
}

function openSubmitDialog() {
  if (!requireCreatorFor("submit")) return;
  elements.submitStatus.textContent = "";
  elements.submitCreatorSummary.textContent =
    `Connecté avec ${state.creator.channelTitle || state.creator.email}. ` +
    "La vidéo doit provenir de cette chaîne.";
  elements.submitDialog.showModal();
}

async function submitVideoRequest(event) {
  event.preventDefault();
  const data = new FormData(elements.submitForm);

  if (!extractYoutubeId(data.get("url"))) {
    showToast("Le lien YouTube n'est pas valide.");
    return;
  }

  if (!API_IS_CONFIGURED) {
    elements.submitStatus.textContent =
      "Les demandes ne sont pas encore activées. Le projet Supabase doit être relié à YouBoost.";
    return;
  }

  setSubmissionBusy(true);
  elements.submitStatus.textContent = "Vérification de la chaîne et de la vidéo…";

  try {
    const token = localStorage.getItem(STORAGE_KEYS.creatorToken);
    const response = await fetch(`${API_BASE_URL}/api/submissions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        videoUrl: data.get("url").trim(),
        category: data.get("category"),
        tags: data.get("tags").trim(),
        note: data.get("note").trim(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem(STORAGE_KEYS.creatorToken);
        state.creator = null;
        renderCreatorAccount();
      }
      throw new Error(result.error || "La demande n'a pas pu être envoyée.");
    }

    elements.submitForm.reset();
    elements.submitDialog.close();
    showToast("Demande envoyée. Vous recevrez la décision par e-mail.");
  } catch (error) {
    elements.submitStatus.textContent = error.message;
  } finally {
    setSubmissionBusy(false);
  }
}

async function loadPublishedVideos() {
  if (!API_IS_CONFIGURED) return [];

  try {
    const response = await fetch(`${API_BASE_URL}/api/videos`);
    if (!response.ok) throw new Error("Catalogue distant inaccessible");
    const result = await response.json();
    return Array.isArray(result.videos) ? result.videos : [];
  } catch (error) {
    console.warn(error);
    return [];
  }
}

function initializeAnalytics() {
  if (!API_IS_CONFIGURED || typeof crypto.randomUUID !== "function") return;

  try {
    const storedVisitorId = localStorage.getItem(STORAGE_KEYS.analyticsVisitor) || "";
    analytics.visitorId = isUuid(storedVisitorId) ? storedVisitorId : crypto.randomUUID();
    if (analytics.visitorId !== storedVisitorId) {
      localStorage.setItem(STORAGE_KEYS.analyticsVisitor, analytics.visitorId);
    }
  } catch {
    analytics.visitorId = crypto.randomUUID();
  }

  analytics.sessionId = crypto.randomUUID();
  analytics.visitId = crypto.randomUUID();
  postAnalytics("/api/analytics/session", {
    visitorId: analytics.visitorId,
    sessionId: analytics.sessionId,
    visitId: analytics.visitId,
  });

  analytics.heartbeatTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") sendAnalyticsHeartbeat();
  }, 30_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sendAnalyticsHeartbeat();
  });
}

function sendAnalyticsHeartbeat() {
  if (!analytics.visitorId || !analytics.sessionId) return;
  postAnalytics("/api/analytics/heartbeat", {
    visitorId: analytics.visitorId,
    sessionId: analytics.sessionId,
  });
}

function trackVideoClick(youtubeId) {
  if (!analytics.visitorId || !analytics.sessionId || !youtubeId) return;
  postAnalytics("/api/analytics/video-click", {
    eventId: crypto.randomUUID(),
    visitorId: analytics.visitorId,
    sessionId: analytics.sessionId,
    youtubeId,
  });
}

async function postAnalytics(path, payload) {
  try {
    await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      keepalive: true,
    });
  } catch {
    // Analytics must never interrupt browsing.
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function setSubmissionBusy(isBusy) {
  elements.submitVideoButton.disabled = isBusy;
  elements.submitVideoButton.classList.toggle("is-loading", isBusy);
}

function closeParentDialog(button) {
  const dialog = button.closest("dialog");
  if (dialog?.open) dialog.close();
}

function closeOnBackdrop(event) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

function extractYoutubeId(input) {
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/")[2] || null;
      }
      return url.searchParams.get("v");
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeVideo(video) {
  return {
    ...video,
    subscribers: Number(video.subscribers) || 0,
    views: Number(video.views) || 0,
    tags: Array.isArray(video.tags) ? video.tags : [],
    creatorInitials: video.creatorInitials || initialsFromName(video.creator),
    isPro: Boolean(video.isPro),
    isApproved: Boolean(video.isApproved),
    creatorAvatar: video.creatorAvatar || null,
    thumbnail:
      video.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeId)}/hqdefault.jpg`,
    accent: video.accent || "#ff393f",
  };
}

function renderChannelAvatar(container, video) {
  container.replaceChildren();
  if (!video.creatorAvatar) {
    container.textContent = video.creatorInitials;
    return;
  }

  const image = document.createElement("img");
  image.src = video.creatorAvatar;
  image.alt = `Photo de profil de ${video.creator}`;
  image.loading = "lazy";
  image.addEventListener(
    "error",
    () => {
      container.replaceChildren();
      container.textContent = video.creatorInitials;
    },
    { once: true },
  );
  container.append(image);
}

function createFallbackThumbnail(video) {
  const title = escapeXml(video.category);
  const creator = escapeXml(video.creator);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="${video.accent}"/>
          <stop offset="1" stop-color="#07142e"/>
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#g)"/>
      <circle cx="320" cy="160" r="46" fill="white" fill-opacity=".92"/>
      <path d="M307 134l42 26-42 26z" fill="${video.accent}"/>
      <text x="32" y="302" fill="white" font-family="Arial" font-size="30" font-weight="700">${title}</text>
      <text x="34" y="332" fill="white" fill-opacity=".75" font-family="Arial" font-size="16">${creator}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function searchableText(video) {
  return normalizeText(
    [video.title, video.creator, video.category, video.description, ...video.tags].join(" "),
  );
}

function normalizeText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatDate(dateString) {
  if (!dateString) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(dateString));
}

function formatInteger(value) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(
    Number(value) || 0,
  );
}

function formatMoney(value) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function formatPercent(value) {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: Number(value) > 0 && Number(value) < 0.1 ? 1 : 0,
  }).format(Number(value) || 0);
}

function studioRangeLabel(range) {
  if (!range?.start || !range?.end) return "";
  const start = new Date(range.start);
  const end = new Date(range.end);
  const date = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  if (state.studioRange === "24h") {
    const dateTime = new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${dateTime.format(start)} au ${dateTime.format(end)}`;
  }
  return `${date.format(start)} au ${date.format(end)}`;
}

function formatStudioChartDate(value, bucket) {
  const date = new Date(value);
  if (bucket === "hour") {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
    }).format(date);
  }
  if (bucket === "month") {
    return new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      year: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

function relativeDate(dateString) {
  if (!dateString) return "";
  const days = calendarDaysSince(dateString);
  if (!Number.isFinite(days)) return "";
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} jours`;
  if (days < 30) return `il y a ${Math.floor(days / 7)} sem.`;
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
  return `il y a ${Math.floor(days / 365)} an${days >= 730 ? "s" : ""}`;
}

function calendarDaysSince(dateString) {
  const timestamp = parseDateTimestamp(dateString);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  const current = new Date();
  const target = new Date(timestamp);
  const currentDay = Date.UTC(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  );
  const targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.floor((currentDay - targetDay) / 86_400_000);
}

function daysSince(dateString) {
  if (!dateString) return Number.NaN;
  const timestamp = parseDateTimestamp(dateString);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

function isWithinHours(dateString, hours) {
  const timestamp = parseDateTimestamp(dateString);
  if (!Number.isFinite(timestamp)) return false;
  const elapsed = Date.now() - timestamp;
  return elapsed >= 0 && elapsed < hours * 3_600_000;
}

function parseDateTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return Number.NaN;
  const normalized = raw
    .replace(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})$/,
      "$1T$2$3:00",
    );
  return new Date(normalized).getTime();
}

function initialsFromName(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function seededNumber(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function saveProfile() {
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(state.profile));
}

function loadProfile() {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.profile);
    if (!value) return structuredClone(DEFAULT_PROFILE);
    const parsed = JSON.parse(value);
    return {
      ...structuredClone(DEFAULT_PROFILE),
      ...parsed,
      rankingVersion: Number(parsed.rankingVersion) || 1,
    };
  } catch {
    return structuredClone(DEFAULT_PROFILE);
  }
}

function migrateRecommendationProfile() {
  if (state.profile.rankingVersion >= 2 || !state.videos.length) return;

  state.profile.categoryWeights = {};
  state.profile.creatorWeights = {};
  state.profile.tagWeights = {};

  state.videos.forEach((video) => {
    const watchedCount = Math.min(3, Number(state.profile.watched[video.id]) || 0);
    if (!watchedCount) return;
    incrementWeight(state.profile.categoryWeights, video.category, watchedCount);
    incrementWeight(state.profile.creatorWeights, video.creator, watchedCount);
    video.tags.forEach((tag) => {
      incrementWeight(state.profile.tagWeights, tag, watchedCount * 0.65);
    });
  });

  state.profile.rankingVersion = 2;
  saveProfile();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2600);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => {
    const entities = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return entities[character];
  });
}
