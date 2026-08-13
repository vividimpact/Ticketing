/*
 * ticketing.js — standalone support-ticket iframe controller.
 *
 * Ported from the per-storefront Four51 AngularJS `supportTicketCtrl.js`, but
 * decoupled from Angular so a single copy on the app server serves every
 * storefront. The parent storefront hands us the signed-in user, the category
 * tree, and the environment via postMessage (see the message contract below);
 * we never read the storefront's Angular scope directly.
 *
 * ==========================  MESSAGE CONTRACT  ==========================
 * Parent -> iframe:  window.postMessage({ type: 'ticketing:init', payload }, iframeOrigin)
 *   payload = {
 *     env: 'production' | 'test',
 *     storefront: '<storefront identifier>',   // optional, for logging/analytics
 *     user: {
 *       id: '<Four51 user id>',
 *       firstName, lastName, email,
 *       companyName,                            // user.Company.Name
 *       allowTicketing: true|false,             // user.AllowTicketing
 *       ticketingDashboard: true|false          // user.TicketingDashboard
 *     },
 *     categoryTree: [ ... ],                     // storefront $scope.tree (see buildCategories)
 *     color: '#1d4f91',                          // optional storefront brand color
 *     vampireToken: '<jwt>'                       // optional token override
 *   }
 *
 * iframe -> parent:  { type: 'ticketing:ready' }   once loaded and listening
 *                    { type: 'ticketing:resize', height }  on content height change
 * ========================================================================
 *
 * Ticket submission reuses the EXISTING Vampire Ticketing application (app id 3)
 * and its client token — the same one the storefronts ship today — so no new
 * Vampire backend is required. See VAMPIRE_TOKEN / VAMPIRE_BASE below.
 */
(function () {
  'use strict';

  // ----- Configuration ------------------------------------------------------
  // No token is committed in this repo. The parent storefront injects the
  // existing Ticketing-application client JWT (applicationId 3, clientId 5 — the
  // same token the per-storefront supportTicketCtrl.js already ships) at runtime
  // via the ticketing:init payload (`vampireToken`, see handleInit). Reusing
  // that token means no new Vampire application is required.
  var VAMPIRE_TOKEN = '';

  // Vampire base URLs. The iframe calls Vampire directly (same host, differing
  // only by path: /api for production, /api-test for test — matching the legacy
  // storefront controller).
  //
  // NOTE: calling vampire.vividimpact.com directly means that on networks where
  // that host resolves to a private/LAN IP, Chrome 142+ Local Network Access
  // (LNA) blocks the request unless the user grants the local-network permission
  // prompt. (Firefox does not enforce LNA.) The app-server reverse proxy
  // (/vampire/api*) avoids this by keeping the browser call same-origin; switch
  // back to the relative '/vampire/api' bases if LNA becomes a problem.
  var VAMPIRE_BASE = {
    production: 'https://vampire.vividimpact.com/api',
    test: 'https://vampire.vividimpact.com/api-test'
  };

  // Cross-origin parents allowed to initialize this iframe. Entries may use a
  // single '*' wildcard for the leftmost host label (e.g. https://*.four51.com).
  // The iframe's OWN origin is always trusted too (see isAllowedParent), which
  // covers the same-origin preview harness at /ticketing/preview.html — both
  // locally and once deployed — without loosening this list.
  // TO CONFIRM: add any storefront custom domains that are not *.four51.com.
  var ALLOWED_PARENT_ORIGINS = [
    'https://*.four51.com',
    'https://*.four51ordercloud.com',
    'https://psfin.atriacom.com:17107',
    'https://www.shopgentivahs.com',
    'https://www.creativehouseorders.com',
    'https://creativehouseprinting.com',
    'https://www.shopcenterwellhomehealth.com'
  ];

  // Max attachment size, in MB. Matches the legacy storefront form, which sent
  // up to 35 MB straight to Vampire successfully — the backend accepts this.
  //
  // The file is base64-encoded inside a form field (~33% inflation), so a 35 MB
  // file is ~47 MB on the wire. Any layer IN FRONT of Vampire must allow at least
  // that: Vampire itself is fine (client_max_body_size / post_max_size = 100M),
  // but a reverse proxy must not cap lower. The apps `/vampire/` proxy's 40m cap
  // was what broke large attachments after the iframe migration — calling Vampire
  // directly (VAMPIRE_BASE above) avoids that proxy, so its 100M limit applies.
  var MAX_UPLOAD_MB = 35;

  // ----- State --------------------------------------------------------------
  var state = {
    env: 'production',
    storefront: null,
    user: null,
    categories: [],
    themeColor: null
  };

  var els = {};

  // ----- Init ---------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    cacheEls();
    wireEvents();
    // Tell the parent we're ready to receive the user payload.
    post({ type: 'ticketing:ready' });
  });

  window.addEventListener('message', function (evt) {
    if (!isAllowedParent(evt.origin)) return;
    var msg = evt.data || {};
    if (msg.type !== 'ticketing:init' || !msg.payload) return;
    handleInit(msg.payload);
  });

  // Trust the iframe's own origin (same-origin preview harness) plus any entry
  // in ALLOWED_PARENT_ORIGINS, where an entry like https://*.four51.com matches
  // any single-label subdomain of four51.com over https.
  function isAllowedParent(origin) {
    if (origin === window.location.origin) return true;
    return ALLOWED_PARENT_ORIGINS.some(function (allowed) {
      if (allowed === origin) return true;
      var w = allowed.indexOf('://*.');
      if (w === -1) return false;
      var scheme = allowed.slice(0, w + 3);   // e.g. 'https://'
      var suffix = allowed.slice(w + 4);      // e.g. '.four51.com'
      return origin.length > scheme.length + suffix.length &&
             origin.slice(0, scheme.length) === scheme &&
             origin.slice(-suffix.length) === suffix;
    });
  }

  function cacheEls() {
    els.app = document.getElementById('app');
    els.notAllowed = document.getElementById('not-allowed');
    els.ticketingError = document.getElementById('ticketing-error');
    els.errorMsg = document.getElementById('ticketing-error-msg');
    els.home = document.getElementById('ticket-home');
    els.ticketsContainer = document.getElementById('tickets-container');
    els.ticketsBody = document.getElementById('tickets-body');
    els.ticketsEmpty = document.getElementById('tickets-empty');
    els.createModal = document.getElementById('create-modal');
    els.noteModal = document.getElementById('note-modal');
    els.frmTicket = document.getElementById('frm-ticket');
    els.frmNote = document.getElementById('frm-note');
    els.requestType = document.getElementById('requestType');
    els.categorySelect = document.querySelector('#frm-ticket select[name="category"]');
    els.upload = document.getElementById('ticketUpload');
    els.uploadError = document.getElementById('upload-error');
    els.flash = document.getElementById('ticket-flash');
    // Keep the on-screen size limit text in sync with MAX_UPLOAD_MB.
    if (els.uploadError) els.uploadError.textContent = 'Files must not exceed ' + MAX_UPLOAD_MB + ' MB';
  }

  function wireEvents() {
    var openBtn = document.getElementById('btn-open-create');
    if (openBtn) openBtn.addEventListener('click', openCreate);
    els.requestType.addEventListener('change', onRequestTypeChange);
    els.frmTicket.addEventListener('submit', onCreateSubmit);
    els.frmNote.addEventListener('submit', onNoteSubmit);
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { closeModals(); });
    });
    // Toggle nested radio-driven blocks (e.g. inventory=yes).
    els.frmTicket.addEventListener('change', function (e) {
      if (e.target.name) toggleRadioBlocks();
    });
    reportHeight();
    window.addEventListener('resize', reportHeight);
  }

  // ----- Handle parent init -------------------------------------------------
  function handleInit(payload) {
    state.env = payload.env === 'test' ? 'test' : 'production';
    state.storefront = payload.storefront || null;
    state.user = payload.user || null;
    state.categories = buildCategories(payload.categoryTree || []);

    // The parent must supply the Vampire client token at runtime (no token is
    // committed in this repo). Without it, the Vampire calls below get a 401.
    if (payload.vampireToken) VAMPIRE_TOKEN = payload.vampireToken;

    // Per-storefront brand color, supplied by the parent (the storefront theme
    // color that used to come from btn-centerwell / the ticket banner). Drives
    // the ticket-request-banner background and the Create Ticket button.
    state.themeColor = payload.themeColor || payload.color || null;
    applyThemeColor(state.themeColor);

    populateCategories();

    // Dashboard users: validate the token + company by loading the ticket list
    // BEFORE revealing the form. If that initial call errors (bad token -> 401,
    // company not set up -> 400, etc.) we show an error popup instead of the
    // form. Non-dashboard users have nothing to load, so reveal the form.
    if (state.user && state.user.ticketingDashboard === true) {
      els.ticketsContainer.hidden = false;
      getTickets(true);
    } else {
      revealApp();
    }
  }

  // Reveal the ticket form: used for non-dashboard users on init, and once the
  // initial ticket load succeeds for dashboard users.
  function revealApp() {
    els.ticketingError.hidden = true;
    els.app.hidden = false;
    var notAllowed = !state.user || state.user.allowTicketing !== true;
    els.notAllowed.hidden = !notAllowed;
    reportHeight();
  }

  // Hide the form and show a blocking error popup (bad token / company, etc.).
  function showLoadError(message) {
    els.app.hidden = true;
    els.errorMsg.textContent = message;
    els.ticketingError.hidden = false;
    reportHeight();
  }

  // Apply the parent-supplied brand color to the CSS custom property the
  // stylesheet reads (--brand-theme). Accepts any CSS color the storefront
  // passes (hex, rgb, or a keyword like 'blue'). No color -> stylesheet default.
  function applyThemeColor(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--brand-theme', color);
  }

  // Flatten the storefront category tree into { id, text, level } rows, matching
  // the recursive walk the legacy controller did over $scope.tree.
  function buildCategories(tree) {
    var out = [];
    function recurse(node, depth, fullPath, name) {
      out.push({ id: fullPath, text: name, level: depth });
      (node.SubCategories || []).forEach(function (sc) {
        recurse(sc, depth + 1, fullPath + ' - ' + sc.Name, ' - ' + sc.Name);
      });
    }
    (tree || []).forEach(function (c) { recurse(c, 0, c.Name, c.Name); });
    return out;
  }

  function populateCategories() {
    if (!els.categorySelect) return;
    els.categorySelect.innerHTML = '';
    state.categories.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.text;
      els.categorySelect.appendChild(opt);
    });
    if (window.jQuery && jQuery.fn.select2) {
      jQuery(els.categorySelect).select2({ width: '100%', dropdownParent: jQuery('#create-modal') });
    }
  }

  // ----- Request-type field visibility -------------------------------------
  function onRequestTypeChange() {
    var type = els.requestType.value;
    // Reset all conditional inputs when switching types (legacy resetTicket()).
    els.frmTicket.querySelectorAll('.option-div input, .option-div textarea, .option-div select')
      .forEach(function (input) {
        if (input.type === 'radio' || input.type === 'checkbox') input.checked = false;
        else input.value = '';
      });
    if (window.jQuery && jQuery.fn.select2 && els.categorySelect) {
      jQuery(els.categorySelect).val(null).trigger('change');
    }
    // Default SKU hint for new products (legacy behavior).
    var sku = els.frmTicket.querySelector('input[name="currentSku"]');
    if (sku) sku.value = (type === 'NewProduct') ? 'Vivid to create' : '';

    els.frmTicket.querySelectorAll('.option-div[data-when]').forEach(function (div) {
      var when = div.getAttribute('data-when').split(/\s+/);
      // '*' means "any request type is selected" (matches legacy requestType !== '').
      var show = (when.indexOf('*') !== -1) ? (type !== '') : (when.indexOf(type) !== -1);
      div.classList.toggle('active', show);
    });
    toggleRadioBlocks();
    reportHeight();
  }

  function toggleRadioBlocks() {
    els.frmTicket.querySelectorAll('.option-div[data-when-radio]').forEach(function (div) {
      var spec = div.getAttribute('data-when-radio').split('=');
      var checked = els.frmTicket.querySelector('input[name="' + spec[0] + '"]:checked');
      div.classList.toggle('active', !!checked && checked.value === spec[1]);
    });
  }

  // ----- Modals -------------------------------------------------------------
  function openCreate() {
    if (!state.user || state.user.allowTicketing !== true) {
      showNotice('Your account is not set up to enter support tickets. If you believe this is an error, please reach out to us.');
      return;
    }
    if (!els.createModal) return;
    els.frmTicket.reset();
    onRequestTypeChange();
    setWorking(els.createModal, false);
    els.createModal.hidden = false;
    reportHeight();
  }

  // In-iframe flash message for submit results (success/error). alert() is
  // silently suppressed inside a cross-origin iframe, so all user feedback must
  // render in the page. isError toggles error styling. Auto-clears on success.
  function flash(msg, isError) {
    if (!els.flash) return;
    // Cancel any pending auto-hide first, so a prior success banner's timeout
    // can't hide a later message. Example: create succeeds (success banner,
    // 8s timer scheduled), then the follow-up getTickets() fails (error banner)
    // — without this, the success timer would prematurely hide the error.
    window.clearTimeout(flash._t);
    flash._t = null;
    els.flash.textContent = msg;
    els.flash.classList.toggle('error', !!isError);
    els.flash.hidden = false;
    reportHeight();
    if (!isError) {
      flash._t = window.setTimeout(function () {
        els.flash.hidden = true;
        flash._t = null;
        reportHeight();
      }, 8000);
    }
  }

  // In-iframe notice — alert()/confirm() are silently suppressed inside a
  // cross-origin iframe, so user feedback must render in the page instead.
  function showNotice(msg) {
    if (els.notAllowed) {
      var p = els.notAllowed.querySelector('p');
      if (p) p.textContent = msg;
      els.notAllowed.hidden = false;
      reportHeight();
    }
  }

  function openNote(uniqueId) {
    if (!state.user || state.user.allowTicketing !== true) {
      showNotice('Your account is not set up to enter support tickets.');
      return;
    }
    els.frmNote.reset();
    els.frmNote.dataset.uniqueId = uniqueId;
    setWorking(els.noteModal, false);
    els.noteModal.hidden = false;
    reportHeight();
  }

  function closeModals() {
    els.createModal.hidden = true;
    els.noteModal.hidden = true;
    reportHeight();
  }

  function setWorking(modal, working) {
    modal.querySelector('.working-message').hidden = !working;
    modal.querySelector('.action-buttons').hidden = working;
  }

  // ----- Submit: create ticket ---------------------------------------------
  function onCreateSubmit(e) {
    e.preventDefault();
    var f = els.frmTicket;
    var description = val(f, 'description');
    if (!description) { flash('Please provide a description.', true); return; }

    // Block oversized attachments up front (before submitting) so the user gets
    // a clear message instead of the backend rejecting it as "file size is too
    // big" — or the ticket silently submitting without the attachment.
    var file = els.upload && els.upload.files && els.upload.files[0];
    if (file && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      els.uploadError.hidden = false;
      flash('That attachment is too large. Files must not exceed ' + MAX_UPLOAD_MB + ' MB.', true);
      return;
    }

    var categories = els.categorySelect
      ? Array.prototype.map.call(els.categorySelect.selectedOptions, function (o) { return o.value; })
      : [];

    readUpload(function (upload) {
      var data = compact({
        companyName: user('companyName'),
        firstName: user('firstName'),
        lastName: user('lastName'),
        email: user('email'),
        subject: 'eCommerce Ticket Request',
        description: description,
        productName: val(f, 'productName'),
        jobType: val(f, 'jobType'),
        inventory: val(f, 'inventory'),
        currentSku: val(f, 'currentSku'),
        category: categories.join(', '),
        placeOnBehalf: val(f, 'placeOnBehalf'),
        productDescription: val(f, 'productDescription'),
        upload: upload,
        source: 'four51',
        userId: user('id'),
        requestType: val(f, 'requestType'),
        newUser: val(f, 'firstLastName'),
        newUserEmail: val(f, 'newUserEmail'),
        groupAssignment: val(f, 'groupAssignment'),
        quantities: val(f, 'quantities'),
        deactivate: val(f, 'deactivate'),
        productTags: val(f, 'productTags'),
        jsonName: val(f, 'jsonName')
      });

      setWorking(els.createModal, true);
      apiPost('create-ticket', data, function (result) {
        if (isValid(result, 'TicketNumber')) {
          if (result.Code === 0) {
            getTickets();
            flash('Support ticket ' + result.Content.TicketNumber + ' has been created.');
          } else {
            flash('Error creating support ticket: ' + result.Message, true);
          }
        } else {
          flash(invalidMsg('create a support ticket'), true);
        }
        closeModals();
      }, function (xhr) {
        flash(submitErrorMessage(xhr, 'create a support ticket'), true);
        closeModals();
      });
    });
  }

  // ----- Submit: add note ---------------------------------------------------
  function onNoteSubmit(e) {
    e.preventDefault();
    var description = val(els.frmNote, 'description');
    if (!description) { flash('Please provide a description.', true); return; }

    var data = compact({
      companyName: user('companyName'),
      firstName: user('firstName'),
      lastName: user('lastName'),
      email: user('email'),
      subject: 'eCommerce Ticket Request',
      description: description,
      source: 'four51',
      userId: user('id'),
      uniqueId: els.frmNote.dataset.uniqueId
    });

    setWorking(els.noteModal, true);
    apiPost('add-note', data, function (result) {
      if (isValid(result)) {
        if (result.Code === 0) {
          getTickets();
          flash('Support ticket has been updated.');
        } else {
          flash('Error creating support ticket note: ' + result.Message, true);
        }
      } else {
        flash(invalidMsg('create a support ticket note'), true);
      }
      closeModals();
    }, function (xhr) {
      flash(submitErrorMessage(xhr, 'create a support ticket note'), true);
      closeModals();
    });
  }

  // ----- Load tickets -------------------------------------------------------
  function getTickets(initial) {
    var data = compact({
      companyName: user('companyName'),
      firstName: user('firstName'),
      lastName: user('lastName'),
      email: user('email'),
      source: 'four51',
      userId: user('id')
    });

    apiPost('tickets', data, function (result) {
      if (isValid(result, 'Tickets') && result.Code === 0) {
        if (initial) revealApp();
        renderTickets(result.Content.Tickets || []);
      } else if (isValid(result, 'Tickets')) {
        if (initial) { showLoadError('Error loading support tickets: ' + result.Message); return; }
        flash('Error loading support tickets: ' + result.Message, true);
      } else {
        if (initial) { showLoadError(invalidMsg('load support tickets')); return; }
        flash(invalidMsg('load support tickets'), true);
      }
    }, function (xhr) {
      if (initial) { showLoadError(loadErrorMessage(xhr)); return; }
      flash(unknownMsg('load support tickets'), true);
    });
  }

  // Friendly message for a failed INITIAL ticket load (validates token/company).
  function loadErrorMessage(xhr) {
    if (xhr && xhr.status === 401) {
      return 'Authentication failed — the ticketing token is missing or invalid.';
    }
    if (xhr && xhr.responseJSON && xhr.responseJSON.Message) {
      return xhr.responseJSON.Message;   // e.g. "Company not setup for external ticketing."
    }
    return unknownMsg('load support tickets');
  }

  // Friendly message for a failed create/note submit. A 413 means the request
  // body (mostly the base64 attachment) exceeded a size limit in front of the
  // backend; surface that clearly, then any backend Message, then a generic one.
  function submitErrorMessage(xhr, action) {
    if (xhr && xhr.status === 413) {
      return 'Your attachment is too large to submit. Please attach a smaller file (under ' +
        MAX_UPLOAD_MB + ' MB) and try again.';
    }
    if (xhr && xhr.responseJSON && xhr.responseJSON.Message) {
      return xhr.responseJSON.Message;
    }
    return unknownMsg(action);
  }

  function renderTickets(tickets) {
    els.ticketsBody.innerHTML = '';
    els.ticketsEmpty.hidden = tickets.length > 0;
    tickets.forEach(function (t) {
      var notes = (t.notes || '').split('<|>').map(function (n) {
        var parts = n.split('<note_parts>');
        return '<div class="notes"><b>' + esc(parts[0]) + '</b><pre>' +
               esc((parts[1] || '').trim()) + '</pre></div>';
      }).join('');
      var canComment = t.unique_id && (t.status === 'Open' || t.status === 'Hold');
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(t.ticket_number) + '</td>' +
        '<td>' + esc(t.date_setup) + '</td>' +
        '<td>' + esc(t.status) + '</td>' +
        '<td>' + notes + '</td>' +
        '<td>' + (canComment ? '<button type="button" class="btn btn-primary">Add Comment</button>' : '') + '</td>';
      if (canComment) {
        tr.querySelector('button').addEventListener('click', function () { openNote(t.unique_id); });
      }
      els.ticketsBody.appendChild(tr);
    });
    reportHeight();
  }

  // ----- Vampire calls ------------------------------------------------------
  function apiPost(method, data, done, fail) {
    jQuery.ajax({
      url: VAMPIRE_BASE[state.env] + '/' + method,
      type: 'POST',
      beforeSend: function (xhr) { xhr.setRequestHeader('Authorization', 'Bearer ' + VAMPIRE_TOKEN); },
      data: data,
      dataType: 'json'
    }).done(done).fail(fail);
  }

  // ----- Helpers ------------------------------------------------------------
  function user(key) {
    var v = state.user ? state.user[key] : '';
    return (typeof v === 'string') ? v.trim() : v;
  }
  function val(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    if (!el) return '';
    if (el.type === 'radio') {
      var checked = form.querySelector('[name="' + name + '"]:checked');
      return checked ? checked.value : '';
    }
    return (el.value || '').trim();
  }
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { if (obj[k]) out[k] = obj[k]; });
    return out;
  }
  function isValid(r, contentKey) {
    if (!r || !('Code' in r) || !('Message' in r) || !('Content' in r)) return false;
    return contentKey ? (r.Content && contentKey in r.Content) : true;
  }
  function readUpload(cb) {
    var file = els.upload && els.upload.files && els.upload.files[0];
    els.uploadError.hidden = true;
    if (!file) return cb(null);
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      els.uploadError.hidden = false;
      return cb(null);
    }
    var reader = new FileReader();
    reader.onload = function () {
      cb({ filename: file.name, filetype: file.type, base64: String(reader.result).split(',')[1] });
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function invalidMsg(action) {
    return 'There was an invalid response when trying to ' + action +
      ', please try again. If the problem persists, please email orders@vividimpact.com';
  }
  function unknownMsg(action) {
    return 'There was an unknown error trying to ' + action +
      ', please try again. If the problem persists, please email orders@vividimpact.com';
  }
  function post(msg) {
    if (window.parent !== window) window.parent.postMessage(msg, '*');
  }
  var __lastReportedHeight = -1;
  function reportHeight() {
    var h;
    if (els.ticketingError && !els.ticketingError.hidden) {
      var box = els.ticketingError.querySelector('.ticketing-error-box');
      h = (box ? box.offsetHeight : 160) + 120;   // room to center the popup
    } else {
      var appEl = document.getElementById('app');
      h = appEl ? appEl.scrollHeight : document.body.scrollHeight;
    }
    // Idempotency guard: only post when the height meaningfully changed. Without
    // this, the parent resizing the iframe fires the iframe's own 'resize' event,
    // which calls reportHeight again — a feedback loop that Chrome storms on (and
    // freezes) while Firefox happens to settle. The 2px tolerance absorbs
    // scrollbar/sub-pixel jitter so the exchange always terminates.
    if (Math.abs(h - __lastReportedHeight) <= 2) return;
    __lastReportedHeight = h;
    post({ type: 'ticketing:resize', height: h });
  }
})();

