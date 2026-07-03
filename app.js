(function () {
  // profile configurations
  var APP_CONFIGS = {
    generic: {
      title: "spot mapper ✦",
      btnText: "◇ Profile: Generic ▾",
      mapUrl: null,
      mapName: null,
      dims: null,
      locations: [],
      spots: [],
      theme: {
        deep: "#7c5fc9",
        accent: "#f6c6d8",
        border: "#b9a7e8",
        mist: "#f3effc",
      },
    },
    sats: {
      title: "show all things show ✦ spot mapper",
      btnText: "△ Profile: SATS ▾",
      mapUrl: null,
      mapName: null,
      dims: null,
      // starts empty, locations and campers get added by hand or by import
      locations: [],
      spots: [],
      theme: {
        deep: "#0181a8",
        accent: "#94e300",
        border: "#6cc4dc",
        mist: "#e9f6fa",
      },
    },
  };

  // shared state sync, backed by /api/state on vercel + upstash kv
  var SYNC_ENDPOINT = "/api/state";
  var DEFAULT_PROFILE = "sats";
  var activeProfile = DEFAULT_PROFILE;
  var syncTimer = null;
  var statusTimer = null;
  var loadToken = 0;
  var stateLoaded = false;

  var map = null;
  var overlay = null;
  var imgDims = null;
  var imgName = null;
  var editMode = false;
  var spots = [];
  var locs = [];
  var markers = {};

  var queue = [];
  var queueActive = false;

  var statusEl = document.getElementById("status");
  var emptyEl = document.getElementById("empty");
  var editBtn = document.getElementById("editbtn");
  var queuePanel = document.getElementById("queuepanel");
  var qNextEl = document.getElementById("qnext");
  var qCountEl = document.getElementById("qcount");
  var sidebarList = document.getElementById("sidebarlist");
  var sidebarEmpty = document.getElementById("sidebarempty");
  var sidebarCount = document.getElementById("sidebarcount");
  var swapBtn = document.getElementById("swapbtn");
  var swapHint = document.getElementById("swaphint");
  var locDatalist = document.getElementById("locnames");

  var swapMode = false;
  var swapFirstId = null;
  var editingId = null;

  var profileBtn = document.getElementById("profilebtn");
  var profileMenu = document.getElementById("profilemenu");

  // profile switching
  profileBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var opening = profileMenu.hidden;
    profileMenu.hidden = !opening;
    profileBtn.setAttribute("aria-expanded", String(opening));
  });

  document.querySelectorAll(".profile-opt").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var profKey = btn.getAttribute("data-profile");
      loadProfile(profKey);
      profileMenu.hidden = true;
    });
  });

  function applyTheme(themeConfig) {
    if (!themeConfig) return;
    var root = document.documentElement.style;
    root.setProperty("--lavender-deep", themeConfig.deep);
    root.setProperty("--blush", themeConfig.accent);
    root.setProperty("--lavender", themeConfig.border);
    root.setProperty("--lavender-mist", themeConfig.mist);
  }

  function loadProfile(key) {
    var config = APP_CONFIGS[key];
    if (!config) return;

    activeProfile = key;
    // remembers which profile was open, the placement data itself lives in kv
    try {
      localStorage.setItem("spotmapper:profile", key);
    } catch (err) {}
    stopQueue();
    if (swapMode) swapBtn.click();
    editingId = null;
    swapFirstId = null;

    document.getElementById("app-title").textContent = config.title;
    profileBtn.textContent = config.btnText;
    applyTheme(config.theme);

    spots = JSON.parse(JSON.stringify(config.spots));
    locs = JSON.parse(JSON.stringify(config.locations));

    updateDatalist();

    if (config.mapUrl) {
      imgName = config.mapName;
      imgDims = config.dims;
      initMap();

      var bounds = [
        [0, 0],
        [imgDims.h, imgDims.w],
      ];
      if (overlay) map.removeLayer(overlay);
      overlay = L.imageOverlay(config.mapUrl, bounds).addTo(map);
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.25));
      map.fitBounds(bounds);

      emptyEl.style.display = "none";
      refreshMarkers();
      refreshStatus();
    } else {
      imgName = null;
      imgDims = null;
      if (overlay && map) {
        map.removeLayer(overlay);
        overlay = null;
      }
      refreshMarkers();
      emptyEl.style.display = "flex";
      refreshStatus();
    }

    loadShared(key);
    if (!config.mapUrl) loadSharedMap(key, loadToken);
  }

  // pull the saved state for this profile so everyone sees the same pins
  function loadShared(profileKey) {
    var token = ++loadToken;
    stateLoaded = false;
    fetch(SYNC_ENDPOINT + "?profile=" + encodeURIComponent(profileKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        // ignore stale responses if the profile changed mid flight
        if (token !== loadToken) return;
        stateLoaded = true;
        if (!data) return;
        if (Array.isArray(data.spots)) spots = data.spots;
        if (Array.isArray(data.locations)) locs = data.locations;
        if (data.image) imgName = data.image;
        if (data.dimensions) imgDims = data.dimensions;
        updateDatalist();
        if (map) refreshMarkers();
        refreshStatus();
      })
      .catch(function () {
        // no backend available, keep working locally
        if (token === loadToken) stateLoaded = true;
      });
  }

  function scheduleSave() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      // never save before the initial load answers, an early save would overwrite shared data with an empty page
      if (!stateLoaded) {
        scheduleSave();
        return;
      }
      saveShared();
    }, 800);
  }

  function saveShared() {
    var payload = {
      image: imgName,
      dimensions: imgDims,
      locations: locs,
      spots: spots,
    };
    fetch(SYNC_ENDPOINT + "?profile=" + encodeURIComponent(activeProfile), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        flashStatus(r.ok ? "☁ saved" : "☁ save failed");
      })
      .catch(function () {
        flashStatus("☁ offline, changes are local only");
      });
  }

  function flashStatus(note) {
    setStatus(baseStatus() + " · " + note);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      setStatus(baseStatus());
    }, 2500);
  }

  // the uploaded map image is shared too, stored in kv as chunks since floor plans outgrow a single value
  var MAP_ENDPOINT = "/api/map";
  var MAP_CHUNK = 700000;

  function loadSharedMap(profileKey, token) {
    fetch(MAP_ENDPOINT + "?profile=" + encodeURIComponent(profileKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (meta) {
        if (token !== loadToken || !meta || !meta.parts) return;
        var partUrls = [];
        for (var i = 0; i < meta.parts; i++) {
          partUrls.push(
            MAP_ENDPOINT +
              "?profile=" +
              encodeURIComponent(profileKey) +
              "&v=" +
              encodeURIComponent(meta.version) +
              "&part=" +
              i,
          );
        }
        Promise.all(
          partUrls.map(function (u) {
            return fetch(u).then(function (r) {
              if (!r.ok) throw new Error("map part failed");
              return r.json();
            });
          }),
        )
          .then(function (chunks) {
            if (token !== loadToken) return;
            var dataUrl = chunks
              .map(function (c) {
                return c.data;
              })
              .join("");
            loadImage(dataUrl, meta.name, true);
          })
          .catch(function () {
            // map fetch failed, pins still load and a fresh upload fixes it
          });
      })
      .catch(function () {});
  }

  function saveMapShared(dataUrl, name) {
    if (dataUrl.length > 20000000) {
      flashStatus("map too large to share, keeping it local");
      return;
    }
    var version = String(Date.now());
    var parts = [];
    for (var i = 0; i < dataUrl.length; i += MAP_CHUNK) {
      parts.push(dataUrl.slice(i, i + MAP_CHUNK));
    }
    flashStatus("sharing map with everyone…");
    var qs = "?profile=" + encodeURIComponent(activeProfile) + "&v=" + version;
    var chain = Promise.resolve();
    parts.forEach(function (part, idx) {
      chain = chain.then(function () {
        return fetch(MAP_ENDPOINT + qs + "&part=" + idx, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: part }),
        }).then(function (r) {
          if (!r.ok) throw new Error("map chunk failed");
        });
      });
    });
    chain
      .then(function () {
        return fetch(MAP_ENDPOINT + qs + "&finalize=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name,
            parts: parts.length,
            version: version,
            dims: imgDims,
          }),
        });
      })
      .then(function (r) {
        flashStatus(
          r && r.ok ? "map shared ☁" : "map share failed, map is local only",
        );
      })
      .catch(function () {
        flashStatus("map share failed, map is local only");
      });
  }

  function findLoc(id) {
    return locs.find(function (l) {
      return l.id === id;
    });
  }

  function campersAt(loc) {
    var key = loc.name.trim().toLowerCase();
    return spots.filter(function (s) {
      return (s.location || "").trim().toLowerCase() === key;
    });
  }

  function updateDatalist() {
    locDatalist.innerHTML = "";
    locs.forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.name;
      locDatalist.appendChild(opt);
    });
  }

  function renderSidebar() {
    sidebarCount.textContent = String(spots.length);
    sidebarList.innerHTML = "";
    sidebarList.classList.toggle("swap-mode", swapMode);
    if (!spots.length && !locs.length) {
      sidebarEmpty.style.display = "block";
      return;
    }
    sidebarEmpty.style.display = "none";

    if (locs.length) {
      appendGroupLabel("locations ⚑");
      locs.forEach(renderLocItem);
      if (spots.length) appendGroupLabel("campers");
    }
    spots.forEach(renderSpotItem);
  }

  function appendGroupLabel(text) {
    var el = document.createElement("div");
    el.className = "sidebar-group";
    el.textContent = text;
    sidebarList.appendChild(el);
  }

  function renderLocItem(l) {
    var item = document.createElement("div");
    item.className =
      "sidebar-item loc" + (l.id === editingId ? " editing" : "");
    item.tabIndex = 0;
    item.setAttribute("role", "button");

    if (l.id === editingId) {
      item.innerHTML =
        '<div class="sidebar-edit-form">' +
        '<input type="text" class="si-edit-name" value="' +
        escapeAttr(l.name) +
        '" aria-label="Location name" placeholder="location name" />' +
        '<div class="row">' +
        '<button class="si-save">save</button>' +
        '<button class="si-cancel">cancel</button>' +
        "</div>" +
        "</div>";

      var nameInput = item.querySelector(".si-edit-name");

      function saveLocEdit() {
        var newName = nameInput.value.trim();
        if (!newName) {
          nameInput.focus();
          return;
        }
        l.name = newName;
        if (markers[l.id]) {
          markers[l.id].setIcon(locIcon(l));
          markers[l.id].setPopupContent(locPopupHtml(l));
        }
        editingId = null;
        updateDatalist();
        renderSidebar();
        scheduleSave();
      }

      item.querySelector(".si-save").addEventListener("click", function (e) {
        e.stopPropagation();
        saveLocEdit();
      });
      item.querySelector(".si-cancel").addEventListener("click", function (e) {
        e.stopPropagation();
        editingId = null;
        renderSidebar();
      });
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") saveLocEdit();
        if (e.key === "Escape") {
          editingId = null;
          renderSidebar();
        }
      });

      sidebarList.appendChild(item);
      nameInput.focus();
      nameInput.select();
      return;
    }

    var count = campersAt(l).length;
    var coordsText = l.lat === 0 && l.lng === 0 ? " (unplaced)" : "";
    item.innerHTML =
      '<span class="si-dot loc"></span>' +
      '<span class="si-text">' +
      '<div class="si-name">' +
      escapeHtml(l.name) +
      coordsText +
      "</div>" +
      '<div class="si-spot">location' +
      (count ? " · " + count + " camper" + (count > 1 ? "s" : "") : "") +
      "</div>" +
      "</span>" +
      '<span class="si-actions">' +
      '<button class="si-edit" title="rename" aria-label="Rename ' +
      escapeHtml(l.name) +
      '">✎</button>' +
      '<button class="si-del" title="remove" aria-label="Remove ' +
      escapeHtml(l.name) +
      '">×</button>' +
      "</span>";

    function focusLoc() {
      if (!map || !markers[l.id] || (l.lat === 0 && l.lng === 0)) return;
      map.panTo([l.lat, l.lng]);
      markers[l.id].setPopupContent(locPopupHtml(l));
      markers[l.id].openPopup();
    }

    item.addEventListener("click", function (e) {
      if (e.target.closest(".si-del") || e.target.closest(".si-edit")) return;
      focusLoc();
    });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusLoc();
      }
    });
    item.querySelector(".si-del").addEventListener("click", function (e) {
      e.stopPropagation();
      window.__removeSpot(l.id);
    });
    item.querySelector(".si-edit").addEventListener("click", function (e) {
      e.stopPropagation();
      editingId = l.id;
      swapFirstId = null;
      renderSidebar();
    });

    sidebarList.appendChild(item);
  }

  function renderSpotItem(s) {
    var item = document.createElement("div");
    item.className =
      "sidebar-item" +
      (s.id === swapFirstId ? " swap-selected" : "") +
      (s.id === editingId ? " editing" : "");
    item.tabIndex = 0;
    item.setAttribute("role", "button");

    if (s.id === editingId) {
      item.innerHTML =
        '<div class="sidebar-edit-form">' +
        '<input type="text" class="si-edit-name" value="' +
        escapeAttr(s.name) +
        '" aria-label="Name" placeholder="who\'s here?" />' +
        '<input type="text" class="si-edit-project" value="' +
        escapeAttr(s.project || "") +
        '" aria-label="Project title" placeholder="project title (optional)" />' +
        '<input type="text" class="si-edit-spot" value="' +
        escapeAttr(s.spot) +
        '" aria-label="Spot label" placeholder="spot # / label" />' +
        '<input type="text" class="si-edit-location" list="locnames" value="' +
        escapeAttr(s.location || "") +
        '" aria-label="Location" placeholder="location (optional)" />' +
        '<textarea class="si-edit-notes" rows="2" aria-label="Notes" placeholder="notes (optional)">' +
        escapeHtml(s.notes || "") +
        "</textarea>" +
        '<div class="row">' +
        '<button class="si-save">save</button>' +
        '<button class="si-cancel">cancel</button>' +
        "</div>" +
        "</div>";

      var nameInput = item.querySelector(".si-edit-name");
      var projectInput = item.querySelector(".si-edit-project");
      var spotInput = item.querySelector(".si-edit-spot");
      var locationInput = item.querySelector(".si-edit-location");
      var notesInput = item.querySelector(".si-edit-notes");

      function saveEdit() {
        var newName = nameInput.value.trim();
        var newSpot = spotInput.value.trim();
        if (!newName) {
          nameInput.focus();
          return;
        }
        s.name = newName;
        s.spot = newSpot || s.spot;
        s.project = projectInput.value.trim();
        s.location = locationInput.value.trim();
        s.notes = notesInput.value.trim();
        if (markers[s.id]) {
          markers[s.id].setIcon(pinIcon(s));
          markers[s.id].setPopupContent(popupHtml(s));
        }
        editingId = null;
        renderSidebar();
        scheduleSave();
      }

      item.querySelector(".si-save").addEventListener("click", function (e) {
        e.stopPropagation();
        saveEdit();
      });
      item.querySelector(".si-cancel").addEventListener("click", function (e) {
        e.stopPropagation();
        editingId = null;
        renderSidebar();
      });
      [nameInput, projectInput, spotInput, locationInput].forEach(
        function (inp) {
          inp.addEventListener("keydown", function (e) {
            if (e.key === "Enter") saveEdit();
            if (e.key === "Escape") {
              editingId = null;
              renderSidebar();
            }
          });
        },
      );
      notesInput.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          editingId = null;
          renderSidebar();
        }
      });

      sidebarList.appendChild(item);
      nameInput.focus();
      nameInput.select();
      return;
    }

    var meta = "spot " + escapeHtml(s.spot);
    if (s.location) meta += " · " + escapeHtml(s.location);
    if (s.lat === 0 && s.lng === 0) meta += " (unplaced)";

    item.innerHTML =
      '<span class="si-dot"></span>' +
      '<span class="si-text">' +
      '<div class="si-name">' +
      escapeHtml(s.name) +
      "</div>" +
      (s.project
        ? '<div class="si-project">' + escapeHtml(s.project) + "</div>"
        : "") +
      '<div class="si-spot">' +
      meta +
      "</div>" +
      (s.notes
        ? '<div class="si-note">' + escapeHtml(s.notes) + "</div>"
        : "") +
      "</span>" +
      '<span class="si-actions">' +
      '<button class="si-edit" title="edit" aria-label="Edit ' +
      escapeHtml(s.name) +
      '">✎</button>' +
      '<button class="si-del" title="remove" aria-label="Remove ' +
      escapeHtml(s.name) +
      '">×</button>' +
      "</span>";

    function focusSpot() {
      if (!map || !markers[s.id] || (s.lat === 0 && s.lng === 0)) return;
      map.panTo([s.lat, s.lng]);
      markers[s.id].openPopup();
    }

    item.addEventListener("click", function (e) {
      if (e.target.closest(".si-del") || e.target.closest(".si-edit")) return;
      if (swapMode) handleSwapPick(s.id);
      else focusSpot();
    });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (swapMode) handleSwapPick(s.id);
        else focusSpot();
      }
    });
    item.querySelector(".si-del").addEventListener("click", function (e) {
      e.stopPropagation();
      window.__removeSpot(s.id);
    });
    item.querySelector(".si-edit").addEventListener("click", function (e) {
      e.stopPropagation();
      editingId = s.id;
      swapFirstId = null;
      renderSidebar();
    });

    sidebarList.appendChild(item);
  }

  function handleSwapPick(id) {
    if (!swapFirstId) {
      swapFirstId = id;
    } else if (swapFirstId === id) {
      swapFirstId = null;
    } else {
      var a = spots.find(function (x) {
        return x.id === swapFirstId;
      });
      var b = spots.find(function (x) {
        return x.id === id;
      });
      if (a && b) {
        var tmpLat = a.lat,
          tmpLng = a.lng;
        a.lat = b.lat;
        a.lng = b.lng;
        b.lat = tmpLat;
        b.lng = tmpLng;

        var tmpSpot = a.spot;
        a.spot = b.spot;
        b.spot = tmpSpot;

        if (markers[a.id]) {
          markers[a.id].setLatLng([a.lat, a.lng]);
          markers[a.id].setIcon(pinIcon(a));
          markers[a.id].setPopupContent(popupHtml(a));
        }
        if (markers[b.id]) {
          markers[b.id].setLatLng([b.lat, b.lng]);
          markers[b.id].setIcon(pinIcon(b));
          markers[b.id].setPopupContent(popupHtml(b));
        }
        setStatus("swapped " + a.name + " ↔ " + b.name);
        scheduleSave();
      }
      swapFirstId = null;
    }
    renderSidebar();
    updateSwapPins();
  }

  function updateSwapPins() {
    Object.keys(markers).forEach(function (id) {
      var el = markers[id].getElement();
      var pin = el && el.querySelector(".spot-pin");
      if (pin)
        pin.classList.toggle("swap-selected", swapMode && id === swapFirstId);
    });
  }

  swapBtn.addEventListener("click", function () {
    swapMode = !swapMode;
    swapFirstId = null;
    editingId = null;
    swapBtn.classList.toggle("active", swapMode);
    swapBtn.setAttribute("aria-pressed", String(swapMode));
    swapHint.hidden = !swapMode;
    renderSidebar();
    updateSwapPins();
  });

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function baseStatus() {
    var parts = [];
    if (imgName && imgDims)
      parts.push(imgName + " · " + imgDims.w + "×" + imgDims.h + "px");
    parts.push(spots.length + " spots");
    if (locs.length) parts.push(locs.length + " locations");
    if (queue.length) parts.push(queue.length + " waiting to place");
    return parts.join(" · ");
  }

  function refreshStatus() {
    setStatus(baseStatus());
    renderSidebar();
  }

  function initMap() {
    if (map) return;
    map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: -4,
      zoomSnap: 0.25,
      attributionControl: false,
    });
    map.on("click", onMapClick);
  }

  function loadImage(url, name, fromServer) {
    var img = new Image();
    img.onload = function () {
      initMap();
      var prevDims = imgDims;
      imgDims = { w: img.naturalWidth, h: img.naturalHeight };
      imgName = name;

      // a differently sized map rescales existing pins so they keep their relative positions
      if (prevDims && (prevDims.w !== imgDims.w || prevDims.h !== imgDims.h)) {
        var sx = imgDims.w / prevDims.w;
        var sy = imgDims.h / prevDims.h;
        var rescaled = false;
        spots.concat(locs).forEach(function (p) {
          if (p.lat === 0 && p.lng === 0) return;
          p.lat = p.lat * sy;
          p.lng = p.lng * sx;
          rescaled = true;
        });
        if (rescaled) flashStatus("pins rescaled to fit the new map size");
      }

      var bounds = [
        [0, 0],
        [imgDims.h, imgDims.w],
      ];
      if (overlay) map.removeLayer(overlay);
      overlay = L.imageOverlay(url, bounds).addTo(map);
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.25));
      map.fitBounds(bounds);
      emptyEl.style.display = "none";

      var centerLat = imgDims.h / 2;
      var centerLng = imgDims.w / 2;
      var offset = 20;

      locs.forEach(function (l, index) {
        if (l.lat === 0 && l.lng === 0) {
          l.lat = centerLat;
          l.lng = centerLng + index * offset - (locs.length * offset) / 2;
        }
      });
      spots.forEach(function (s, index) {
        if (s.lat === 0 && s.lng === 0) {
          s.lat = centerLat - 40;
          s.lng = centerLng + index * offset - (spots.length * offset) / 2;
        }
      });

      refreshMarkers();
      refreshStatus();
      if (!fromServer) {
        scheduleSave();
        saveMapShared(url, name);
      }
    };
    img.src = url;
  }

  function readAndLoadImage(file) {
    if (!file || file.type.indexOf("image/") !== 0) return;
    var reader = new FileReader();
    reader.onload = function () {
      loadImage(reader.result, file.name);
    };
    reader.readAsDataURL(file);
  }

  document.getElementById("mapfile").addEventListener("change", function (e) {
    readAndLoadImage(e.target.files[0]);
  });

  var uploadZone = document.querySelector(".uploadzone");
  if (uploadZone) {
    ["dragenter", "dragover"].forEach(function (evt) {
      uploadZone.addEventListener(evt, function (e) {
        e.preventDefault();
        uploadZone.classList.add("dragover");
      });
    });
    uploadZone.addEventListener("dragleave", function () {
      uploadZone.classList.remove("dragover");
    });
    uploadZone.addEventListener("drop", function (e) {
      e.preventDefault();
      uploadZone.classList.remove("dragover");
      readAndLoadImage(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  function pinIcon(s) {
    var cls = "spot-pin" + (s.__queued ? " queued" : "");
    return L.divIcon({
      className: "",
      html:
        '<div class="' +
        cls +
        '" data-id="' +
        s.id +
        '">' +
        '<div class="spot-dot"></div>' +
        '<div class="spot-chip">' +
        escapeHtml(s.spot || s.name) +
        "</div>" +
        "</div>",
      iconSize: [0, 0],
    });
  }

  function locIcon(l) {
    return L.divIcon({
      className: "",
      html:
        '<div class="spot-pin loc-pin" data-id="' +
        l.id +
        '">' +
        '<div class="loc-dot"></div>' +
        '<div class="spot-chip loc-chip">⚑ ' +
        escapeHtml(l.name) +
        "</div>" +
        "</div>",
      iconSize: [0, 0],
    });
  }

  function popupHtml(s) {
    var html = '<div class="popup-name">' + escapeHtml(s.name) + "</div>";
    if (s.project)
      html += '<div class="popup-project">' + escapeHtml(s.project) + "</div>";
    var meta = "spot " + escapeHtml(s.spot);
    if (s.location) meta += " · " + escapeHtml(s.location);
    html += '<div class="popup-spot">' + meta + "</div>";
    if (s.notes)
      html += '<div class="popup-notes">' + escapeHtml(s.notes) + "</div>";
    html +=
      '<div class="popup-actions">' +
      '<button class="popup-edit" onclick="window.__editSpot(\'' +
      s.id +
      "')\">✎ edit</button>" +
      (editMode
        ? '<button class="popup-del" onclick="window.__removeSpot(\'' +
          s.id +
          "')\">remove</button>"
        : "") +
      "</div>";
    return html;
  }

  function locPopupHtml(l) {
    var html =
      '<div class="popup-name">⚑ ' +
      escapeHtml(l.name) +
      "</div>" +
      '<div class="popup-spot">location</div>';
    var here = campersAt(l);
    if (here.length) {
      html += '<div class="popup-loc-list">';
      here.forEach(function (s) {
        html +=
          '<div class="popup-loc-camper">' +
          escapeHtml(s.name) +
          ' <span class="popup-loc-spot">spot ' +
          escapeHtml(s.spot) +
          "</span></div>";
      });
      html += "</div>";
    } else {
      html += '<div class="popup-notes">no campers assigned here yet</div>';
    }
    html +=
      '<div class="popup-actions">' +
      '<button class="popup-edit" onclick="window.__editSpot(\'' +
      l.id +
      "')\">✎ rename</button>" +
      (editMode
        ? '<button class="popup-del" onclick="window.__removeSpot(\'' +
          l.id +
          "')\">remove</button>"
        : "") +
      "</div>";
    return html;
  }

  function addMarker(s) {
    if (s.lat === 0 && s.lng === 0) return;
    var m = L.marker([s.lat, s.lng], {
      icon: pinIcon(s),
      draggable: editMode,
      keyboard: true,
    }).addTo(map);
    m.bindPopup(popupHtml(s), { maxWidth: 280, maxHeight: 260 });
    m.on("click", function () {
      if (swapMode) {
        handleSwapPick(s.id);
        return;
      }
      m.openPopup();
    });
    m.on("dragend", function () {
      var ll = m.getLatLng();
      s.lat = ll.lat;
      s.lng = ll.lng;
      scheduleSave();
    });
    markers[s.id] = m;
  }

  function addLocMarker(l) {
    if (l.lat === 0 && l.lng === 0) return;
    var m = L.marker([l.lat, l.lng], {
      icon: locIcon(l),
      draggable: editMode,
      keyboard: true,
    }).addTo(map);
    m.bindPopup(locPopupHtml(l), { maxWidth: 280, maxHeight: 260 });
    m.on("click", function () {
      if (swapMode) return;
      m.setPopupContent(locPopupHtml(l));
      m.openPopup();
    });
    m.on("dragend", function () {
      var ll = m.getLatLng();
      l.lat = ll.lat;
      l.lng = ll.lng;
      scheduleSave();
    });
    markers[l.id] = m;
  }

  function refreshMarkers() {
    if (!map) return;
    Object.keys(markers).forEach(function (id) {
      map.removeLayer(markers[id]);
    });
    markers = {};
    locs.forEach(addLocMarker);
    spots.forEach(addMarker);
    updateSwapPins();
  }

  var pendingLL = null;
  var ghost = null;
  var panel = document.getElementById("addpanel");
  var addType = "spot";
  var typeSpotBtn = document.getElementById("ptypespot");
  var typeLocBtn = document.getElementById("ptypeloc");

  function setAddType(type) {
    addType = type;
    var isLoc = type === "loc";
    typeSpotBtn.classList.toggle("active", !isLoc);
    typeSpotBtn.setAttribute("aria-pressed", String(!isLoc));
    typeLocBtn.classList.toggle("active", isLoc);
    typeLocBtn.setAttribute("aria-pressed", String(isLoc));
    document.getElementById("pname").placeholder = isLoc
      ? "location name, e.g. amphitheater"
      : "who's here?";
    ["pproject", "pspot", "plocation", "pnotes"].forEach(function (id) {
      document.getElementById(id).hidden = isLoc;
    });
  }
  typeSpotBtn.addEventListener("click", function () {
    setAddType("spot");
    document.getElementById("pname").focus();
  });
  typeLocBtn.addEventListener("click", function () {
    setAddType("loc");
    document.getElementById("pname").focus();
  });

  function closePanel() {
    panel.hidden = true;
    pendingLL = null;
    if (ghost) {
      map.removeLayer(ghost);
      ghost = null;
    }
  }

  function makeDraggable(el) {
    var handle = el.querySelector(".panel-head");
    if (!handle) return;
    var dragging = false;
    var startX, startY, startLeft, startTop;
    function pointOf(e) {
      return e.touches && e.touches.length ? e.touches[0] : e;
    }
    function onDown(e) {
      if (e.target.closest(".panel-close")) return;
      var p = pointOf(e);
      var rect = el.getBoundingClientRect();
      dragging = true;
      startX = p.clientX;
      startY = p.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      el.style.left = startLeft + "px";
      el.style.top = startTop + "px";
      el.style.right = "auto";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    }
    function onMove(e) {
      if (!dragging) return;
      var p = pointOf(e);
      var dx = p.clientX - startX;
      var dy = p.clientY - startY;
      var newLeft = Math.max(
        -el.offsetWidth + 80,
        Math.min(startLeft + dx, window.innerWidth - 80),
      );
      var newTop = Math.max(
        4,
        Math.min(startTop + dy, window.innerHeight - 40),
      );
      el.style.left = newLeft + "px";
      el.style.top = newTop + "px";
      if (e.cancelable) e.preventDefault();
    }
    function onUp() {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    }
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
  }

  makeDraggable(panel);
  document.getElementById("paddclose").addEventListener("click", closePanel);

  function makeId() {
    return "s" + Date.now() + Math.floor(Math.random() * 1000);
  }

  function onMapClick(e) {
    if (!editMode || !overlay) return;

    if (queueActive && queue.length) {
      var row = queue.shift();
      var s = {
        id: makeId(),
        name: row.name,
        spot: row.spot || String(spots.length + 1),
        project: row.project || "",
        location: row.location || "",
        notes: row.notes || "",
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      };
      spots.push(s);
      addMarker(s);
      refreshStatus();
      updateQueuePanel();
      scheduleSave();
      if (!queue.length) stopQueue();
      return;
    }

    pendingLL = e.latlng;
    if (ghost) map.removeLayer(ghost);
    ghost = L.circleMarker(e.latlng, {
      radius: 9,
      color: "var(--lavender-deep)",
      weight: 3,
      fillColor: "var(--blush)",
      fillOpacity: 0.9,
    }).addTo(map);
    setAddType(addType);
    document.getElementById("pspot").value = String(spots.length + 1);
    document.getElementById("pname").value = "";
    document.getElementById("pproject").value = "";
    document.getElementById("plocation").value = "";
    document.getElementById("pnotes").value = "";
    panel.hidden = false;
    document.getElementById("pname").focus();
  }

  document.getElementById("paddbtn").addEventListener("click", function () {
    var name = document.getElementById("pname").value.trim();
    if (!name || !pendingLL) return;

    if (addType === "loc") {
      var l = {
        id: makeId(),
        name: name,
        lat: pendingLL.lat,
        lng: pendingLL.lng,
      };
      locs.push(l);
      addLocMarker(l);
      updateDatalist();
      refreshStatus();
      closePanel();
      scheduleSave();
      return;
    }

    var spot = document.getElementById("pspot").value.trim();
    var s = {
      id: makeId(),
      name: name,
      spot: spot || String(spots.length + 1),
      project: document.getElementById("pproject").value.trim(),
      location: document.getElementById("plocation").value.trim(),
      notes: document.getElementById("pnotes").value.trim(),
      lat: pendingLL.lat,
      lng: pendingLL.lng,
    };
    spots.push(s);
    addMarker(s);
    refreshStatus();
    closePanel();
    scheduleSave();
  });

  document.getElementById("pcancel").addEventListener("click", closePanel);
  ["pname", "pproject", "pspot", "plocation"].forEach(function (id, i, arr) {
    document.getElementById(id).addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      for (var j = i + 1; j < arr.length; j++) {
        var next = document.getElementById(arr[j]);
        if (!next.hidden) {
          next.focus();
          return;
        }
      }
      document.getElementById("paddbtn").click();
    });
  });

  editBtn.addEventListener("click", function () {
    editMode = !editMode;
    editBtn.classList.toggle("active", editMode);
    editBtn.setAttribute("aria-pressed", String(editMode));
    editBtn.textContent = editMode
      ? "✎ editing — click map to add"
      : "✎ edit mode";
    refreshMarkers();
  });

  document.getElementById("search").addEventListener("input", function (e) {
    var q = e.target.value.trim().toLowerCase();
    var firstHit = null;
    spots.forEach(function (s) {
      var el = markers[s.id] && markers[s.id].getElement();
      var pin = el && el.querySelector(".spot-pin");
      if (!pin) return;
      var match =
        q &&
        (s.name.toLowerCase().includes(q) ||
          s.spot.toLowerCase().includes(q) ||
          (s.project || "").toLowerCase().includes(q) ||
          (s.location || "").toLowerCase().includes(q) ||
          (s.notes || "").toLowerCase().includes(q));
      pin.classList.toggle("found", !!match);
      pin.classList.toggle("dim", !!q && !match);
      if (match && !firstHit) firstHit = s;
    });
    locs.forEach(function (l) {
      var el = markers[l.id] && markers[l.id].getElement();
      var pin = el && el.querySelector(".spot-pin");
      if (!pin) return;
      var match = q && l.name.toLowerCase().includes(q);
      pin.classList.toggle("found", !!match);
      pin.classList.toggle("dim", !!q && !match);
      if (match && !firstHit) firstHit = l;
    });
    if (firstHit) {
      map.panTo([firstHit.lat, firstHit.lng]);
      markers[firstHit.id].openPopup();
    }
  });

  var dataBtn = document.getElementById("databtn");
  var dataMenu = document.getElementById("datamenu");
  function closeDataMenu() {
    dataMenu.hidden = true;
    dataBtn.setAttribute("aria-expanded", "false");
  }

  dataBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var opening = dataMenu.hidden;
    dataMenu.hidden = !opening;
    dataBtn.setAttribute("aria-expanded", String(opening));
  });

  document.addEventListener("click", function (e) {
    if (!dataMenu.hidden && !e.target.closest("#datadrop")) closeDataMenu();
    if (!profileMenu.hidden && !e.target.closest("#profiledrop"))
      profileMenu.hidden = true;
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !dataMenu.hidden) {
      closeDataMenu();
      dataBtn.focus();
    }
  });

  document.getElementById("exportbtn").addEventListener("click", function () {
    var payload = {
      image: imgName,
      dimensions: imgDims,
      locations: locs,
      spots: spots,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spots.json";
    a.click();
    URL.revokeObjectURL(a.href);
    closeDataMenu();
  });

  // clears the on-screen map/pins and returns the ui to the empty state
  function wipeLocalView() {
    clearTimeout(syncTimer);
    stopQueue();
    if (swapMode) swapBtn.click();
    editingId = null;
    swapFirstId = null;

    spots = [];
    locs = [];
    imgName = null;
    imgDims = null;
    if (overlay && map) {
      map.removeLayer(overlay);
      overlay = null;
    }
    updateDatalist();
    refreshMarkers();
    emptyEl.style.display = "flex";
    refreshStatus();
  }

  // deletes one profile's saved state + map from the shared backend
  function wipeProfileBackend(profileKey) {
    return Promise.all([
      fetch(SYNC_ENDPOINT + "?profile=" + encodeURIComponent(profileKey), {
        method: "DELETE",
      }),
      fetch(MAP_ENDPOINT + "?profile=" + encodeURIComponent(profileKey), {
        method: "DELETE",
      }),
    ]);
  }

  document.getElementById("resetbtn").addEventListener("click", function () {
    var config = APP_CONFIGS[activeProfile];
    var label = (config && config.title) || activeProfile;
    var sure = window.confirm(
      'reset "' +
        label +
        '"? this deletes the map and all spots/locations for everyone, on this device and in the shared backend. this cannot be undone.',
    );
    if (!sure) return;

    wipeLocalView();

    flashStatus("resetting…");
    var profileAtReset = activeProfile;
    wipeProfileBackend(profileAtReset)
      .then(function (results) {
        var ok = results.every(function (r) {
          return r.ok;
        });
        flashStatus(ok ? "reset ☁" : "reset locally, backend clear failed");
      })
      .catch(function () {
        flashStatus("reset locally, backend is offline");
      });
  });

  document.getElementById("resetallbtn").addEventListener("click", function () {
    var profileKeys = Object.keys(APP_CONFIGS);
    var names = profileKeys
      .map(function (k) {
        return (APP_CONFIGS[k] && APP_CONFIGS[k].title) || k;
      })
      .join(", ");
    var sure = window.confirm(
      "reset ALL profiles (" +
        names +
        ")? this deletes every map and every spot/location for everyone, on this device and in the shared backend, regardless of which profile is currently open. this cannot be undone.",
    );
    if (!sure) return;

    // the view is showing one of the profiles being wiped, so clear it too
    wipeLocalView();

    flashStatus("resetting all profiles…");
    Promise.all(
      profileKeys.map(function (key) {
        return wipeProfileBackend(key);
      }),
    )
      .then(function (perProfileResults) {
        var ok = perProfileResults.every(function (results) {
          return results.every(function (r) {
            return r.ok;
          });
        });
        flashStatus(
          ok
            ? "all profiles reset ☁"
            : "reset locally, some backend clears failed",
        );
      })
      .catch(function () {
        flashStatus("reset locally, backend is offline");
      });
  });

  document
    .getElementById("importfile")
    .addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          spots = data.spots || [];
          locs = data.locations || [];
          updateDatalist();
          if (map) refreshMarkers();
          refreshStatus();
          scheduleSave();
        } catch (err) {
          setStatus("could not read that JSON");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
      closeDataMenu();
    });

  // header aliases recognized in imported spreadsheets
  var NAME_KEYS = [
    "name",
    "who",
    "person",
    "guest",
    "camper",
    "campers",
    "camper(s)",
  ];
  var SPOT_KEYS = [
    "spot",
    "space",
    "label",
    "number",
    "no",
    "#",
    "seat",
    "spot #",
    "spot number",
  ];
  var PROJECT_KEYS = [
    "project",
    "project title",
    "project titles",
    "project title(s)",
    "title",
  ];
  var LOCATION_KEYS = ["location", "area", "zone", "room", "where"];
  var NOTES_KEYS = ["notes", "note", "description", "desc", "about"];
  var LAT_KEYS = ["lat", "latitude", "y"];
  var LNG_KEYS = ["lng", "lon", "long", "longitude", "x"];

  // parses csv text into a row matrix, handles quoted cells with commas, escaped quotes, and newlines inside quotes
  function parseCSVMatrix(text) {
    var rows = [];
    var row = [];
    var cell = "";
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell.trim());
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell.trim());
        cell = "";
        rows.push(row);
        row = [];
      } else {
        cell += c;
      }
    }
    row.push(cell.trim());
    rows.push(row);
    return rows.filter(function (r) {
      return r.some(function (c) {
        return c !== "";
      });
    });
  }

  function looksLikeHeader(nameVal, spotVal) {
    return (
      NAME_KEYS.includes((nameVal || "").toLowerCase()) ||
      SPOT_KEYS.includes((spotVal || "").toLowerCase())
    );
  }

  function parseCSV(text) {
    var matrix = parseCSVMatrix(text);
    if (matrix.length < 2) return [];

    var headers = matrix[0].map(function (h) {
      return h.toLowerCase();
    });
    function findIdx(keys) {
      return headers.findIndex(function (h) {
        return keys.includes(h);
      });
    }
    var indices = {
      name: findIdx(NAME_KEYS),
      spot: findIdx(SPOT_KEYS),
      project: findIdx(PROJECT_KEYS),
      location: findIdx(LOCATION_KEYS),
      notes: findIdx(NOTES_KEYS),
      lat: findIdx(LAT_KEYS),
      lng: findIdx(LNG_KEYS),
    };

    // positional guesses only kick in when no headers were recognized at all,
    // otherwise unmatched columns stay empty instead of grabbing the wrong data
    var recognized = Object.keys(indices).some(function (k) {
      return indices[k] !== -1;
    });
    if (!recognized) {
      indices.name = 0;
      if (headers.length > 1) indices.spot = 1;
      if (headers.length > 2) indices.project = 2;
      if (headers.length > 3) indices.location = 3;
      if (headers.length > 4) indices.notes = 4;
    } else if (indices.name === -1) {
      indices.name = 0;
    }

    function cellAt(cells, idx) {
      return idx !== -1 && cells[idx] ? cells[idx] : "";
    }

    var parsedRows = [];
    for (var i = 1; i < matrix.length; i++) {
      var cells = matrix[i];
      var nameVal = cellAt(cells, indices.name);
      var spotVal = cellAt(cells, indices.spot);
      // only rows with a filled camper name count, skips banner rows, blank rows, and repeated header rows
      if (!nameVal || looksLikeHeader(nameVal, spotVal)) continue;
      var latVal = cellAt(cells, indices.lat);
      var lngVal = cellAt(cells, indices.lng);
      parsedRows.push({
        name: nameVal,
        spot: spotVal,
        project: cellAt(cells, indices.project),
        location: cellAt(cells, indices.location),
        notes: cellAt(cells, indices.notes),
        lat: latVal ? parseFloat(latVal) : NaN,
        lng: lngVal ? parseFloat(lngVal) : NaN,
      });
    }
    return parsedRows;
  }

  // rows with coordinates go straight to the map, the rest go to the placing queue
  function ingestRows(rows) {
    if (!rows.length) {
      alert("Couldn't extract any data rows.");
      return;
    }
    var mapRows = [];
    var queueRows = [];
    rows.forEach(function (r) {
      if (!isNaN(r.lat) && !isNaN(r.lng)) mapRows.push(r);
      else queueRows.push(r);
    });
    mapRows.forEach(function (r) {
      var s = {
        id: makeId(),
        name: r.name,
        spot: r.spot,
        project: r.project,
        location: r.location,
        notes: r.notes,
        lat: r.lat,
        lng: r.lng,
      };
      spots.push(s);
      if (map) addMarker(s);
    });
    if (mapRows.length) scheduleSave();
    if (queueRows.length) {
      queue = queue.concat(queueRows);
      startQueue();
    } else {
      refreshStatus();
    }
  }

  document.getElementById("sheetfile").addEventListener("change", function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var isExcel = /\.(xlsx|xls)$/i.test(file.name);
    var reader = new FileReader();
    reader.onload = function (evt) {
      var text;
      if (isExcel) {
        if (typeof XLSX === "undefined") {
          alert(
            "Excel support didn't load. Check your connection or use a .csv file.",
          );
          return;
        }
        try {
          var wb = XLSX.read(evt.target.result, { type: "array" });
          var sheet = wb.Sheets[wb.SheetNames[0]];
          text = XLSX.utils.sheet_to_csv(sheet);
        } catch (err) {
          alert("Couldn't read that Excel file.");
          return;
        }
      } else {
        text = evt.target.result;
      }
      ingestRows(parseCSV(text));
    };
    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
    e.target.value = "";
    closeDataMenu();
  });

  function startQueue() {
    queueActive = true;
    updateQueuePanel();
    if (!editMode) editBtn.click();
  }
  function stopQueue() {
    queue = [];
    queueActive = false;
    queuePanel.hidden = true;
    refreshStatus();
  }

  function updateQueuePanel() {
    if (!queue.length) {
      stopQueue();
      return;
    }
    var current = queue[0];
    qNextEl.innerHTML =
      "place: <strong>" +
      escapeHtml(current.name) +
      "</strong>" +
      (current.spot
        ? ' <span class="qbadge">spot ' + escapeHtml(current.spot) + "</span>"
        : "");
    qCountEl.textContent = queue.length + " remaining in sheet queue";
    queuePanel.hidden = false;
  }

  document.getElementById("qskip").addEventListener("click", function () {
    if (queue.length) {
      queue.shift();
      updateQueuePanel();
    }
  });
  document.getElementById("qclose").addEventListener("click", stopQueue);
  document.getElementById("qcancel").addEventListener("click", stopQueue);

  makeDraggable(queuePanel);

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(str) {
    if (!str) return "";
    return escapeHtml(str).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
  }

  document.getElementById("printbtn").addEventListener("click", function () {
    var printArea = document.getElementById("printarea");
    var today = new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    function spotNum(s) {
      var m = String(s.spot || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : Infinity;
    }
    function rowsTable(list) {
      var sorted = list.slice().sort(function (a, b) {
        return spotNum(a) - spotNum(b);
      });
      var html =
        "<table><thead><tr><th>spot</th><th>camper</th><th>project</th></tr></thead><tbody>";
      sorted.forEach(function (s) {
        html +=
          "<tr><td>" +
          escapeHtml(s.spot) +
          "</td><td>" +
          escapeHtml(s.name) +
          "</td><td>" +
          escapeHtml(s.project || "") +
          "</td></tr>";
      });
      return html + "</tbody></table>";
    }
    var html =
      "<h2>spot mapper ✦ placements</h2><p class='print-meta'>" +
      (imgName ? escapeHtml(imgName) + " · " : "") +
      spots.length +
      " spots · " +
      today +
      "</p>";
    var grouped = {};
    var unassigned = [];
    spots.forEach(function (s) {
      var key = (s.location || "").trim();
      if (!key) unassigned.push(s);
      else {
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s);
      }
    });
    var seen = {};
    locs.forEach(function (l) {
      var key = l.name.trim();
      seen[key.toLowerCase()] = true;
      var list = grouped[key] || [];
      html += "<h3>" + escapeHtml(l.name) + "</h3>" + rowsTable(list);
    });
    Object.keys(grouped).forEach(function (key) {
      if (seen[key.toLowerCase()]) return;
      html += "<h3>" + escapeHtml(key) + "</h3>" + rowsTable(grouped[key]);
    });
    if (unassigned.length) html += rowsTable(unassigned);
    printArea.innerHTML = html;
    window.print();
  });

  window.__editSpot = function (id) {
    if (map) map.closePopup();
    editingId = id;
    swapFirstId = null;
    renderSidebar();
  };

  window.__removeSpot = function (id) {
    spots = spots.filter(function (s) {
      return s.id !== id;
    });
    var wasLoc = !!findLoc(id);
    locs = locs.filter(function (l) {
      return l.id !== id;
    });
    if (markers[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
    if (wasLoc) updateDatalist();
    refreshStatus();
    scheduleSave();
  };

  function rememberedProfile() {
    try {
      var saved = localStorage.getItem("spotmapper:profile");
      return APP_CONFIGS[saved] ? saved : DEFAULT_PROFILE;
    } catch (err) {
      return DEFAULT_PROFILE;
    }
  }

  loadProfile(rememberedProfile());
})();
