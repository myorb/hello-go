// components/baseui/scroll_lock.js
// Port of @base-ui/utils/useScrollLock.ts. Helpers from useTimeout.ts,
// useAnimationFrame.ts, platform/os.ts, platform/engine.ts, @floating-ui/utils/dom,
// and @base-ui/react/utils/useAnchoredPopupScrollLock.ts live here as well.
(function () {
  "use strict";

  // @base-ui/utils/platform/{os,engine}.ts
  const lowerPlatform = navigator.platform.toLowerCase();
  const ios = /^i(os$|p)/.test(lowerPlatform) ||
    (lowerPlatform === "macintel" && navigator.maxTouchPoints > 1);
  const webkit = typeof CSS !== "undefined" && !!CSS.supports?.("-webkit-backdrop-filter:none");

  const ownerDocument = (referenceElement) => referenceElement?.ownerDocument || document;
  const ownerWindow = (referenceElement) =>
    (referenceElement?.nodeType === 9 ? referenceElement : ownerDocument(referenceElement)).defaultView || window;

  // @floating-ui/utils/dom: isOverflowElement
  function isOverflowElement(element) {
    const { overflow, overflowX, overflowY, display } = ownerWindow(element).getComputedStyle(element);
    return /auto|scroll|overlay|hidden|clip/.test(overflow + overflowY + overflowX) &&
      display !== "inline" && display !== "contents";
  }

  // @base-ui/utils/useTimeout.ts (the imperative helper; no React lifecycle).
  class Timeout {
    static create() { return new Timeout(); }
    currentId = 0;
    start(delay, fn) {
      this.clear();
      this.currentId = setTimeout(() => {
        this.currentId = 0;
        fn();
      }, delay);
    }
    isStarted() { return this.currentId !== 0; }
    clear = () => {
      if (this.currentId !== 0) {
        clearTimeout(this.currentId);
        this.currentId = 0;
      }
    };
  }

  // @base-ui/utils/useAnimationFrame.ts, including its production scheduler.
  class Scheduler {
    callbacks = [];
    callbacksCount = 0;
    nextId = 1;
    startId = 1;
    isScheduled = false;
    tick = (timestamp) => {
      this.isScheduled = false;
      const currentCallbacks = this.callbacks;
      const currentCallbacksCount = this.callbacksCount;
      this.callbacks = [];
      this.callbacksCount = 0;
      this.startId = this.nextId;
      if (currentCallbacksCount > 0) {
        for (let i = 0; i < currentCallbacks.length; i += 1) {
          currentCallbacks[i]?.(timestamp);
        }
      }
    };
    request(fn) {
      const id = this.nextId;
      this.nextId += 1;
      this.callbacks.push(fn);
      this.callbacksCount += 1;
      if (!this.isScheduled) {
        requestAnimationFrame(this.tick);
        this.isScheduled = true;
      }
      return id;
    }
    cancel(id) {
      const index = id - this.startId;
      if (index < 0 || index >= this.callbacks.length || this.callbacks[index] === null) return;
      this.callbacks[index] = null;
      this.callbacksCount -= 1;
    }
  }
  const scheduler = new Scheduler();
  class AnimationFrame {
    static create() { return new AnimationFrame(); }
    static request(fn) { return scheduler.request(fn); }
    static cancel(id) { scheduler.cancel(id); }
    currentId = null;
    request(fn) {
      this.cancel();
      this.currentId = scheduler.request(() => {
        this.currentId = null;
        fn();
      });
    }
    cancel = () => {
      if (this.currentId !== null) {
        scheduler.cancel(this.currentId);
        this.currentId = null;
      }
    };
  }

  let originalHtmlStyles = {};
  let originalBodyStyles = {};
  let originalHtmlScrollBehavior = '';

  // The viewport's overflow comes from <html> when it establishes its own scroll container, and
  // propagates from <body> otherwise. An `overflow` style on the other element doesn't lock the page.
  function getViewportScroller(html, body) {
    return isOverflowElement(html) ? html : body;
  }

  function isPageScrollLocked(win, html, body) {
    return /hidden|clip/.test(win.getComputedStyle(getViewportScroller(html, body)).overflowY);
  }

  function hasInsetScrollbars(referenceElement) {
    if (typeof document === 'undefined') {
      return false;
    }
    const doc = ownerDocument(referenceElement);
    const win = ownerWindow(doc);
    return win.innerWidth - doc.documentElement.clientWidth > 0;
  }

  function supportsStableScrollbarGutter(referenceElement) {
    const supported =
      typeof CSS !== 'undefined' && CSS.supports && CSS.supports('scrollbar-gutter', 'stable');

    if (!supported || typeof document === 'undefined') {
      return false;
    }

    const doc = ownerDocument(referenceElement);
    const html = doc.documentElement;
    const body = doc.body;

    const scrollContainer = getViewportScroller(html, body);

    const originalScrollContainerOverflowY = scrollContainer.style.overflowY;
    const originalHtmlStyleGutter = html.style.scrollbarGutter;

    html.style.scrollbarGutter = 'stable';

    scrollContainer.style.overflowY = 'scroll';
    const before = scrollContainer.offsetWidth;

    scrollContainer.style.overflowY = 'hidden';
    const after = scrollContainer.offsetWidth;

    scrollContainer.style.overflowY = originalScrollContainerOverflowY;
    html.style.scrollbarGutter = originalHtmlStyleGutter;

    return before === after;
  }

  function preventScrollOverlayScrollbars(referenceElement) {
    const doc = ownerDocument(referenceElement);
    const html = doc.documentElement;
    const body = doc.body;

    // If an `overflow` style is present on <html>, we need to lock it, because a lock on <body>
    // won't have any effect.
    // But if <body> has an `overflow` style (like `overflow-x: hidden`), we need to lock it
    // instead, as sticky elements shift otherwise.
    const elementToLock = getViewportScroller(html, body);
    const originalElementToLockStyles = {
      overflowY: elementToLock.style.overflowY,
      overflowX: elementToLock.style.overflowX,
    };

    Object.assign(elementToLock.style, {
      overflowY: 'hidden',
      overflowX: 'hidden',
    });

    return () => {
      Object.assign(elementToLock.style, originalElementToLockStyles);
    };
  }

  function preventScrollInsetScrollbars(referenceElement) {
    const doc = ownerDocument(referenceElement);
    const html = doc.documentElement;
    const body = doc.body;
    const win = ownerWindow(html);

    let scrollTop = 0;
    let scrollLeft = 0;
    let updateGutterOnly = false;
    const resizeFrame = AnimationFrame.create();

    // Pinch-zoom in Safari causes a shift. Just don't lock scroll if there's any pinch-zoom.
    if (webkit && (win.visualViewport?.scale ?? 1) !== 1) {
      return () => {};
    }

    function lockScroll() {
      /* DOM reads: */

      const htmlStyles = win.getComputedStyle(html);
      const bodyStyles = win.getComputedStyle(body);
      const htmlScrollbarGutterValue = htmlStyles.scrollbarGutter || '';
      const hasBothEdges = htmlScrollbarGutterValue.includes('both-edges');
      const scrollbarGutterValue = hasBothEdges ? 'stable both-edges' : 'stable';

      scrollTop = html.scrollTop;
      scrollLeft = html.scrollLeft;

      originalHtmlStyles = {
        scrollbarGutter: html.style.scrollbarGutter,
        overflowY: html.style.overflowY,
        overflowX: html.style.overflowX,
      };
      originalHtmlScrollBehavior = html.style.scrollBehavior;

      originalBodyStyles = {
        position: body.style.position,
        height: body.style.height,
        width: body.style.width,
        boxSizing: body.style.boxSizing,
        overflowY: body.style.overflowY,
        overflowX: body.style.overflowX,
        scrollBehavior: body.style.scrollBehavior,
      };

      const isScrollableY = html.scrollHeight > html.clientHeight;
      const isScrollableX = html.scrollWidth > html.clientWidth;
      const hasConstantOverflowY =
        htmlStyles.overflowY === 'scroll' || bodyStyles.overflowY === 'scroll';
      const hasConstantOverflowX =
        htmlStyles.overflowX === 'scroll' || bodyStyles.overflowX === 'scroll';

      // Values can be negative in Firefox
      const scrollbarWidth = Math.max(0, win.innerWidth - body.clientWidth);
      const scrollbarHeight = Math.max(0, win.innerHeight - body.clientHeight);

      // Avoid shift due to the default <body> margin. This does cause elements to be clipped
      // with whitespace. Warn if <body> has margins?
      const marginY = parseFloat(bodyStyles.marginTop) + parseFloat(bodyStyles.marginBottom);
      const marginX = parseFloat(bodyStyles.marginLeft) + parseFloat(bodyStyles.marginRight);
      const elementToLock = getViewportScroller(html, body);

      updateGutterOnly = supportsStableScrollbarGutter(referenceElement);

      /*
       * DOM writes:
       * Do not read the DOM past this point!
       */

      if (updateGutterOnly) {
        html.style.scrollbarGutter = scrollbarGutterValue;
        elementToLock.style.overflowY = 'hidden';
        elementToLock.style.overflowX = 'hidden';
        return;
      }

      Object.assign(html.style, {
        scrollbarGutter: scrollbarGutterValue,
        overflowY: 'hidden',
        overflowX: 'hidden',
      });

      if (isScrollableY || hasConstantOverflowY) {
        html.style.overflowY = 'scroll';
      }
      if (isScrollableX || hasConstantOverflowX) {
        html.style.overflowX = 'scroll';
      }

      Object.assign(body.style, {
        position: 'relative',
        height:
          marginY || scrollbarHeight ? `calc(100dvh - ${marginY + scrollbarHeight}px)` : '100dvh',
        width: marginX || scrollbarWidth ? `calc(100vw - ${marginX + scrollbarWidth}px)` : '100vw',
        boxSizing: 'border-box',
        // Assign the longhands that `cleanup` restores, so nothing is left behind.
        overflowY: 'hidden',
        overflowX: 'hidden',
        scrollBehavior: 'unset',
      });

      body.scrollTop = scrollTop;
      body.scrollLeft = scrollLeft;
      html.setAttribute('data-tui-scroll-locked', '');
      html.style.scrollBehavior = 'unset';
    }

    function cleanup() {
      Object.assign(html.style, originalHtmlStyles);
      Object.assign(body.style, originalBodyStyles);

      if (!updateGutterOnly) {
        html.scrollTop = scrollTop;
        html.scrollLeft = scrollLeft;
        html.removeAttribute('data-tui-scroll-locked');
        html.style.scrollBehavior = originalHtmlScrollBehavior;
      }
    }

    function handleResize() {
      cleanup();
      resizeFrame.request(lockScroll);
    }

    lockScroll();
    win.addEventListener('resize', handleResize);

    return () => {
      resizeFrame.cancel();
      cleanup();
      // Sometimes this cleanup can run after test teardown because it is called
      // in a `setTimeout(fn, 0)`. Guard the returned cleanup to avoid calling
      // `removeEventListener` when it is no longer available in tests.
      if (typeof win.removeEventListener === 'function') {
        win.removeEventListener('resize', handleResize);
      }
    };
  }

  class ScrollLocker {
    lockCount = 0;
    restore = null;
    timeoutLock = Timeout.create();
    timeoutUnlock = Timeout.create();

    acquire(referenceElement) {
      this.lockCount += 1;
      if (this.lockCount === 1 && this.restore === null) {
        this.timeoutLock.start(0, () => this.lock(referenceElement));
      }
      return this.release;
    }

    release = () => {
      this.lockCount -= 1;
      if (this.lockCount === 0 && this.restore) {
        this.timeoutUnlock.start(0, this.unlock);
      }
    };

    unlock = () => {
      if (this.lockCount === 0 && this.restore) {
        this.restore?.();
        this.restore = null;
      }
    };

    lock(referenceElement) {
      if (this.lockCount === 0 || this.restore !== null) {
        return;
      }

      const doc = ownerDocument(referenceElement);
      const html = doc.documentElement;
      const body = doc.body;
      const win = ownerWindow(html);

      // The page is already locked, either by the site author or by a non-Base UI overlay that
      // hasn't cleaned up yet. Leave it alone and wait for the lock to clear before taking over,
      // otherwise we'd snapshot the locked state and restore it after our own lock is released.
      if (isPageScrollLocked(win, html, body)) {
        const observer = new win.MutationObserver(() => {
          if (isPageScrollLocked(win, html, body)) {
            return;
          }
          observer.disconnect();
          this.restore = null;
          this.lock(referenceElement);
        });

        // Watch every attribute: locks are applied through inline styles, classes, or attributes
        // paired with a stylesheet (`data-scroll-locked` in react-remove-scroll, for example).
        const options = { attributes: true };

        observer.observe(html, options);
        observer.observe(body, options);

        this.restore = () => observer.disconnect();
        return;
      }

      const hasOverlayScrollbars = ios || !hasInsetScrollbars(referenceElement);

      // On iOS, scroll locking does not work if the navbar is collapsed. Due to numerous
      // side effects and bugs that arise on iOS, it must be researched extensively before
      // being enabled to ensure it doesn't cause the following issues:
      // - Textboxes must scroll into view when focused, nor cause a glitchy scroll animation.
      // - The navbar must not force itself into view and cause layout shift.
      // - Scroll containers must not flicker upon closing a popup when it has an exit animation.
      this.restore = hasOverlayScrollbars
        ? preventScrollOverlayScrollbars(referenceElement)
        : preventScrollInsetScrollbars(referenceElement);
    }
  }

  const SCROLL_LOCKER = new ScrollLocker();

  // @base-ui/react/utils/useAnchoredPopupScrollLock.ts: run after positioning.
  const VIEWPORT_WIDTH_TOLERANCE_PX = 20;
  function anchoredPopupScrollLock(enabled, touchOpen, positionerElement, referenceElement) {
    let touchOpenShouldLockScroll = false;
    if (enabled && touchOpen && positionerElement != null) {
      const viewportWidth = ownerDocument(positionerElement).documentElement.clientWidth;
      const popupWidth = positionerElement.offsetWidth;
      touchOpenShouldLockScroll = viewportWidth > 0 && popupWidth > 0 &&
        popupWidth >= viewportWidth - VIEWPORT_WIDTH_TOLERANCE_PX;
    }
    return enabled && (!touchOpen || touchOpenShouldLockScroll)
      ? SCROLL_LOCKER.acquire(referenceElement)
      : () => {};
  }

  window.tui = window.tui || {};
  window.tui.scrollLock = {
    acquire: (referenceElement) => SCROLL_LOCKER.acquire(referenceElement),
    anchoredPopup: anchoredPopupScrollLock,
  };
})();

// components/dialog/dialog.js
(function () {
  "use strict";

  // Vanilla port of Base UI's Dialog (packages/react/src/dialog): the portal
  // node, backdrop and popup are SSRd divs; this script drives Base UI's
  // data-open/data-closed/data-starting-style/data-ending-style transition
  // lifecycle, the FloatingFocusManager focus trap (guards, initial focus,
  // return focus), useDismiss's escape/outside-press semantics, markOthers'
  // aria-hidden application to outside content and useScrollLock's deferred
  // body lock. "Unmount" is the portal node getting [hidden] again.

  // ----- registry ------------------------------------------------------------

  // Popup element -> per-dialog state. The open stack orders open dialogs by
  // open time (last = topmost), like Base UI's nested dialog counts.
  const dialogs = new Map();
  const openStack = [];

  function getDialog(target) {
    if (!target) return null;
    if (typeof target === "string") {
      const el = document.getElementById(target);
      return el && el.matches("[data-tui-dialog-content]") ? el : null;
    }
    if (target.matches?.("[data-tui-dialog-content]")) return target;
    return target.closest?.("[data-tui-dialog-content]") || null;
  }

  function stateOf(target) {
    const popup = getDialog(target);
    return popup ? dialogs.get(popup) : null;
  }

  function dialogFor(element) {
    const id =
      element.getAttribute("aria-controls") || element.getAttribute("data-tui-dialog-target");
    if (id) return getDialog(id);
    return getDialog(element);
  }

  function triggersFor(popup) {
    if (!popup.id) return [];
    return document.querySelectorAll(
      '[data-tui-dialog-trigger][aria-controls="' + popup.id + '"]',
    );
  }

  function isModal(state) {
    return state.popup.getAttribute("data-tui-dialog-show-modal") !== "false";
  }

  // ----- interaction type ----------------------------------------------------

  // FloatingFocusManager tracks the last pointer/keyboard interaction to pick
  // touch initial focus and keyboard-visible return focus.
  let lastInteractionType = "";
  document.addEventListener(
    "pointerdown",
    (event) => {
      lastInteractionType = event.pointerType || "mouse";
    },
    true,
  );
  document.addEventListener(
    "keydown",
    () => {
      lastInteractionType = "keyboard";
    },
    true,
  );

  // ----- tabbable (floating-ui-react/utils/tabbable.ts) ----------------------

  const CANDIDATE_SELECTOR =
    'a[href],button,input,select,textarea,summary,details,iframe,object,embed,[tabindex],[contenteditable]:not([contenteditable="false"]),audio[controls],video[controls]';

  function isFocusableElement(element) {
    if (
      !element.matches(CANDIDATE_SELECTOR) ||
      !element.isConnected ||
      element.matches(":disabled") ||
      (element.localName === "input" && element.type === "hidden")
    ) {
      return false;
    }
    for (let current = element; current; current = current.parentElement) {
      const isAncestor = current !== element;
      if (current.hasAttribute("inert") || current.hasAttribute("hidden")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none") return false;
      if (!isAncestor && (style.visibility === "hidden" || style.visibility === "collapse")) {
        return false;
      }
      if (
        isAncestor &&
        current.localName === "details" &&
        !current.open &&
        !(current.querySelector(":scope > summary")?.contains(element))
      ) {
        return false;
      }
    }
    return true;
  }

  function getTabIndex(element) {
    const tabIndex = element.tabIndex;
    if (tabIndex < 0) {
      const name = element.localName;
      if (name === "details" || name === "audio" || name === "video" || element.isContentEditable) {
        return 0;
      }
    }
    return tabIndex;
  }

  function getNamedRadioInput(element) {
    return element.localName === "input" && element.type === "radio" && element.name !== ""
      ? element
      : null;
  }

  function isTabbableRadio(element, candidates) {
    const input = getNamedRadioInput(element);
    if (!input) return true;
    const group = candidates.filter((candidate) => {
      const radio = getNamedRadioInput(candidate);
      return radio && radio.name === input.name && radio.form === input.form;
    });
    const checked = group.find((radio) => radio.checked);
    return checked ? checked === input : group[0] === input;
  }

  function focusable(container) {
    return Array.from(container.querySelectorAll(CANDIDATE_SELECTOR)).filter(isFocusableElement);
  }

  function tabbable(container) {
    const candidates = focusable(container);
    return candidates.filter(
      (element) => getTabIndex(element) >= 0 && isTabbableRadio(element, candidates),
    );
  }

  function isTabbable(element) {
    return isFocusableElement(element) && getTabIndex(element) >= 0;
  }

  // FloatingFocusManager.getFirstTabbableElement: the element if it is
  // tabbable, otherwise its first tabbable child, otherwise itself.
  // (handleTabIndex is not ported: it early-returns for elements with an
  // authored tabindex, and FOCUSABLE_POPUP_PROPS always renders the dialog
  // popup with tabindex="-1" — ours is SSRd the same way and never changes.)
  function getFirstTabbableElement(container) {
    if (!container) return null;
    if (isTabbable(container)) return container;
    return tabbable(container)[0] || container;
  }

  // floating-ui-react/utils/enqueueFocus: focus lands on the next frame; a
  // newer enqueue cancels the previous one.
  let focusFrame = 0;
  function enqueueFocus(el, options = {}) {
    if (!el) return;
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      if (options.shouldFocus && !options.shouldFocus()) return;
      el.focus(options);
    });
  }

  // ----- markOthers (floating-ui-react/utils/markOthers.ts) ------------------

  // Applies aria-hidden="true" to everything outside the open dialogs, with
  // reference counting so nested opens undo cleanly. aria-live regions are
  // kept, like Base UI. (Base UI's modal dialogs use aria-hidden, not inert:
  // pointer interaction is blocked by the full-viewport backdrop.)
  const ariaHiddenCounts = new WeakMap();
  const ariaHiddenUncontrolled = new WeakSet();

  function collectOutsideElements(keepElements, stopElements) {
    const outside = [];
    const walk = (parent) => {
      if (!parent || stopElements.has(parent)) return;
      for (const node of parent.children) {
        if (node.localName === "script") continue;
        if (keepElements.has(node)) {
          walk(node);
        } else {
          outside.push(node);
        }
      }
    };
    walk(document.body);
    return outside;
  }

  function buildKeepSet(targets) {
    const keep = new Set();
    targets.forEach((target) => {
      let node = target;
      while (node && !keep.has(node)) {
        keep.add(node);
        node = node.parentElement;
      }
    });
    return keep;
  }

  function markOthers(avoidElements) {
    const controlElements = avoidElements.concat(
      Array.from(document.body.querySelectorAll("[aria-live]")),
    );
    const targets = collectOutsideElements(
      buildKeepSet(controlElements),
      new Set(controlElements),
    );
    const hiddenElements = [];

    targets.forEach((node) => {
      const attr = node.getAttribute("aria-hidden");
      const alreadyHidden = attr !== null && attr !== "false";
      const count = (ariaHiddenCounts.get(node) || 0) + 1;
      ariaHiddenCounts.set(node, count);
      hiddenElements.push(node);
      if (count === 1 && alreadyHidden) ariaHiddenUncontrolled.add(node);
      if (!alreadyHidden) node.setAttribute("aria-hidden", "true");
    });

    return () => {
      hiddenElements.forEach((node) => {
        const count = (ariaHiddenCounts.get(node) || 0) - 1;
        ariaHiddenCounts.set(node, count);
        if (count <= 0) {
          if (!ariaHiddenUncontrolled.has(node)) node.removeAttribute("aria-hidden");
          ariaHiddenUncontrolled.delete(node);
        }
      });
    };
  }

  // ----- aria wiring (useDialogTitle/-Description registration) --------------

  function wireAria(state) {
    const popup = state.popup;
    const title = popup.querySelector("[data-tui-dialog-title]");
    if (title) {
      if (!title.id) title.id = popup.id + "-title";
      popup.setAttribute("aria-labelledby", title.id);
    } else {
      popup.removeAttribute("aria-labelledby");
    }
    const description = popup.querySelector("[data-tui-dialog-description]");
    if (description) {
      if (!description.id) description.id = popup.id + "-description";
      popup.setAttribute("aria-describedby", description.id);
    } else {
      popup.removeAttribute("aria-describedby");
    }
  }

  // ----- transition lifecycle ------------------------------------------------

  function setTransitionAttributes(state, attrs) {
    [state.backdrop, state.popup].forEach((el) => {
      if (!el) return;
      ["data-open", "data-closed", "data-starting-style", "data-ending-style"].forEach((name) => {
        if (attrs.includes(name)) {
          el.setAttribute(name, "");
        } else {
          el.removeAttribute(name);
        }
      });
    });
  }

  // useOpenChangeComplete/useAnimationsFinished: wait for every animation and
  // transition on the popup to finish, then run fn (a resolved microtask runs
  // before the browser paints the post-animation frame, so hiding here never
  // flashes the natural styles, like Base UI's flushSync unmount).
  function whenAnimationsFinish(state, fn) {
    const token = {};
    state.finishToken = token;
    const popup = state.popup;
    if (typeof popup.getAnimations !== "function") {
      fn();
      return;
    }
    // Base UI waits on the popup's animations only (useOpenChangeComplete's
    // ref is the popup); the backdrop uses the same durations.
    Promise.allSettled(popup.getAnimations().map((animation) => animation.finished)).then(() => {
      if (state.finishToken === token) fn();
    });
  }

  // ----- nested dialog bookkeeping ------------------------------------------

  // A dialog is nested when its hidden portal node was SSRd inside another
  // dialog's content — the DOM pendant of Base UI's parent DialogRootContext. The
  // relation is recorded at registration (see ensureDialog); parentOf resolves
  // it to the parent's live state.
  function parentOf(state) {
    const parentId = state.root.getAttribute("data-tui-dialog-parent");
    return parentId ? stateOf(parentId) : null;
  }

  function nestedOpenCount(state) {
    return openStack.filter((other) => {
      for (let p = parentOf(other); p; p = parentOf(p)) {
        if (p === state) return true;
      }
      return false;
    }).length;
  }

  function updateNestedAttributes() {
    openStack.forEach((state) => {
      const count = nestedOpenCount(state);
      state.popup.style.setProperty("--nested-dialogs", String(count));
      state.popup.toggleAttribute("data-nested-dialog-open", count > 0);
    });
  }

  function isTopmost(state) {
    return nestedOpenCount(state) === 0;
  }

  // ----- open / close --------------------------------------------------------

  function updateTriggers(state, isOpen) {
    triggersFor(state.popup).forEach((trigger) => {
      trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      trigger.toggleAttribute("data-popup-open", isOpen);
    });
  }

  function openDialog(target, trigger) {
    const state = stateOf(target);
    if (!state || state.open) return;
    state.finishToken = null; // cancel a pending exit unmount

    const popup = state.popup;
    state.openType = trigger ? lastInteractionType || "mouse" : null;
    state.trigger =
      trigger && trigger instanceof Element ? trigger : triggersFor(popup)[0] || null;
    state.previouslyFocused = document.activeElement;

    state.open = true;
    openStack.push(state);
    updateNestedAttributes();

    // FloatingPortal appends at open time, keeping paint order = open order.
    document.body.appendChild(state.root);
    state.root.hidden = false;

    wireAria(state);

    // useTransitionStatus: mount with data-open + data-starting-style, drop
    // the starting style a frame later so CSS transitions see the start
    // values (the reflow guarantees they were computed).
    setTransitionAttributes(state, ["data-open", "data-starting-style"]);
    void popup.offsetWidth;
    requestAnimationFrame(() => {
      if (state.open) setTransitionAttributes(state, ["data-open"]);
    });

    if (isModal(state)) {
      state.releaseScroll = window.tui.scrollLock.acquire(popup);
      state.undoMarkOthers = markOthers([state.root]);
    }

    updateTriggers(state, true);

    // FloatingFocusManager initial focus: first tabbable element, or the
    // popup itself — also when opened by touch, so the virtual keyboard
    // stays closed (createDefaultInitialFocus).
    queueMicrotask(() => {
      if (!state.open) return;
      if (popup.contains(document.activeElement)) return;
      const elToFocus =
        state.openType === "touch" ? popup : tabbable(popup)[0] || popup;
      enqueueFocus(elToFocus, {
        preventScroll: elToFocus === popup,
        shouldFocus() {
          if (!state.open) return false;
          const active = document.activeElement;
          return !(active !== elToFocus && popup.contains(active));
        },
      });
    });
  }

  function closeDialog(target) {
    const state = stateOf(target);
    if (!state || !state.open) return;

    const popup = state.popup;
    state.open = false;
    state.closeType = lastInteractionType;
    const index = openStack.indexOf(state);
    if (index !== -1) openStack.splice(index, 1);
    updateNestedAttributes();

    // Base UI order on open=false: the transition status flips to ending,
    // aria-hidden marking and the scroll lock release immediately, the
    // popup unmounts (and focus returns) once the exit animation finishes.
    setTransitionAttributes(state, ["data-closed", "data-ending-style"]);
    if (state.undoMarkOthers) {
      state.undoMarkOthers();
      state.undoMarkOthers = null;
    }
    state.releaseScroll?.();
    state.releaseScroll = null;
    updateTriggers(state, false);

    whenAnimationsFinish(state, () => {
      state.root.hidden = true;
      setTransitionAttributes(state, []);
      popup.style.removeProperty("--nested-dialogs");
      popup.removeAttribute("data-nested-dialog-open");
      returnFocus(state);
      // onOpenChangeComplete(false) pendant: fires once the exit animation
      // finished and the dialog unmounted (command.js resets its palette on
      // this).
      popup.dispatchEvent(new CustomEvent("dialog-close", { bubbles: true }));
    });
  }

  // FloatingFocusManager return focus: the trigger (or the previously
  // focused element for programmatic opens), resolved to its first tabbable,
  // focused without scrolling — visibly when the dialog was closed with the
  // keyboard. Focus that legitimately moved elsewhere is respected.
  function returnFocus(state) {
    const referenceReturn = state.trigger?.isConnected ? state.trigger : null;
    const previousReturn =
      state.previouslyFocused?.isConnected &&
      state.previouslyFocused.localName !== "body"
        ? state.previouslyFocused
        : null;
    const preferPreviousFocus = state.openType == null;
    const returnElement = preferPreviousFocus
      ? previousReturn || referenceReturn
      : referenceReturn || previousReturn;

    queueMicrotask(() => {
      const tabbableReturnElement = getFirstTabbableElement(returnElement);
      if (!tabbableReturnElement) return;
      const active = document.activeElement;
      const focusMovedElsewhere =
        tabbableReturnElement !== active &&
        active !== document.body &&
        !state.popup.contains(active) &&
        !state.root.contains(active);
      if (focusMovedElsewhere) return;
      const options = { preventScroll: true };
      if (state.closeType === "keyboard") options.focusVisible = true;
      tabbableReturnElement.focus(options);
    });
  }

  function isDialogOpen(target) {
    return stateOf(target)?.open || false;
  }

  function requestOpenChange(target, nextOpen, trigger) {
    const state = stateOf(target);
    if (!state || state.open === nextOpen) return false;
    const accepted = state.popup.dispatchEvent(
      new CustomEvent("dialog-open-change", {
        bubbles: true,
        cancelable: true,
        detail: { open: nextOpen },
      }),
    );
    if (!accepted || state.popup.hasAttribute("data-tui-dialog-controlled")) return false;
    if (nextOpen) openDialog(state.popup, trigger);
    else closeDialog(state.popup);
    return true;
  }

  function toggleDialog(target, trigger) {
    requestOpenChange(target, !isDialogOpen(target), trigger);
  }

  // ----- dismissal (useDismiss + DialogInteractions) -------------------------

  // With a rendered backdrop, Base UI's outsidePressEvent is 'intentional':
  // the dismissal fires on the click that completes a press on the dialog's
  // owning backdrop, only for the topmost dialog, only for the main button.
  // A press that starts inside the popup and is released over the backdrop
  // (text selection drag-out) never dismisses.
  let pressStartedInPopup = null;
  document.addEventListener(
    "pointerdown",
    (event) => {
      pressStartedInPopup =
        event.target instanceof Element
          ? event.target.closest("[data-tui-dialog-content]")
          : null;
    },
    true,
  );

  function handleBackdropClick(backdrop, event) {
    const state = stateOf(backdrop.parentElement?.querySelector("[data-tui-dialog-content]"));
    if (!state || !state.open) return;
    if (state.popup.hasAttribute("data-tui-dialog-disable-dismissible")) return;
    if (!isTopmost(state)) return;
    if (event.button !== 0) return;
    if (pressStartedInPopup === state.popup) return;
    requestOpenChange(state.popup, false);
  }

  // useDismiss escape key: closes the topmost dialog, ignoring presses that
  // settle an IME composition (Safari fires compositionend before keydown,
  // so the flag is cleared a few ms later there).
  let isComposing = false;
  let compositionTimer;
  const isWebkit =
    typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  document.addEventListener("compositionstart", () => {
    window.clearTimeout(compositionTimer);
    isComposing = true;
  });
  document.addEventListener("compositionend", () => {
    compositionTimer = window.setTimeout(
      () => {
        isComposing = false;
      },
      isWebkit ? 5 : 0,
    );
  });

  const escapeTargets = new WeakSet();
  function listenForEscape(element) {
    if (!element || escapeTargets.has(element)) return;
    element.addEventListener("keydown", closeOnEscapeKeyDown);
    escapeTargets.add(element);
  }

  // useDismiss installs the same handler on the popup, reference and document.
  function closeOnEscapeKeyDown(event) {
    if (event.key !== "Escape" || isComposing) return;
    const top = openStack[openStack.length - 1];
    const state = event.currentTarget === document
      ? top
      : stateOf(dialogFor(event.currentTarget));
    // A nested open dialog blocks its parent's useDismiss handler.
    if (!state?.open || state !== top) return;
    if (requestOpenChange(state.popup, false)) event.preventDefault();
    event.stopPropagation();
    return true;
  }

  document.addEventListener("keydown", (event) => {
    if (closeOnEscapeKeyDown(event)) return;
    // FloatingFocusManager: prevent Tab from escaping the modal when the
    // popup has no tabbable elements (the guards would have nothing to
    // focus).
    if (event.key === "Tab") {
      const state = openStack.find(
        (other) => isModal(other) && other.popup.contains(document.activeElement),
      );
      if (state && tabbable(state.popup).length === 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  });

  // ----- initialization ------------------------------------------------------

  // FocusGuard: visually hidden tabbable sentinels around the popup; focusing
  // one wraps focus to the other end of the popup's tab cycle.
  function createFocusGuard() {
    const guard = document.createElement("span");
    guard.setAttribute("tabindex", "0");
    guard.setAttribute("aria-hidden", "true");
    guard.setAttribute("data-tui-dialog-focus-guard", "");
    guard.style.cssText =
      "clip-path:inset(50%);overflow:hidden;white-space:nowrap;border:0;padding:0;width:1px;height:1px;margin:-1px;position:fixed;top:0;left:0;";
    return guard;
  }

  function ensureDialog(root) {
    const popup = root.querySelector("[data-tui-dialog-content]");
    if (!popup || dialogs.has(popup)) return dialogs.get(popup) || null;

    const parentPopup = root.parentElement?.closest("[data-tui-dialog-content]");
    if (parentPopup?.id) root.setAttribute("data-tui-dialog-parent", parentPopup.id);
    if (!root._tuiPortalOwner) root._tuiPortalOwner = root.parentElement;

    const state = {
      root,
      popup,
      backdrop: root.querySelector("[data-tui-dialog-backdrop]"),
      open: false,
      trigger: null,
      previouslyFocused: null,
      openType: null,
      closeType: "",
      undoMarkOthers: null,
      releaseScroll: null,
      finishToken: null,
    };
    dialogs.set(popup, state);
    listenForEscape(popup);

    // A nested dialog renders no backdrop in Base UI (DialogBackdrop's
    // enabled: !nested); the parent's backdrop keeps covering the page.
    if (root.hasAttribute("data-tui-dialog-parent")) {
      popup.setAttribute("data-nested", "");
      if (state.backdrop) state.backdrop.hidden = true;
    }

    const beforeGuard = createFocusGuard();
    const afterGuard = createFocusGuard();
    if (!isModal(state)) {
      // Non-modal dialogs do not trap focus: the guards stay out of the tab
      // order (Base UI renders different non-modal guard behavior; without a
      // React portal boundary the natural tab order is the equivalent).
      beforeGuard.setAttribute("tabindex", "-1");
      afterGuard.setAttribute("tabindex", "-1");
    }
    popup.before(beforeGuard);
    popup.after(afterGuard);
    beforeGuard.addEventListener("focus", () => {
      if (!isModal(state)) return;
      const els = tabbable(popup);
      enqueueFocus(els[els.length - 1] || popup, { preventScroll: els.length === 0 });
    });
    afterGuard.addEventListener("focus", () => {
      if (!isModal(state)) return;
      const els = tabbable(popup);
      enqueueFocus(els[0] || popup, { preventScroll: els.length === 0 });
    });

    // FloatingFocusManager restoreFocus="popup": when the focused element is
    // removed from inside the popup (e.g. an htmx swap of the dialog body),
    // focus falls back to the popup instead of escaping to <body>.
    popup.addEventListener("focusout", (event) => {
      const target = event.target;
      queueMicrotask(() => {
        if (!state.open) return;
        if (target instanceof Element && target.isConnected) return;
        if (document.activeElement === document.body) {
          popup.focus();
          requestAnimationFrame(() => {
            if (state.open && document.activeElement === document.body) popup.focus();
          });
        }
      });
    });

    wireAria(state);
    return state;
  }

  // Fully retire a dialog: undo aria-hidden marking, release the scroll
  // lock and remove the portaled DOM. Used when an htmx/datastar swap
  // removed the dialog's source from the page or replaced it with a fresh
  // hidden portal node.
  function destroyDialog(popup) {
    const state = dialogs.get(popup);
    if (!state) {
      popup.closest("[data-tui-dialog-root]")?.remove();
      return;
    }
    state.finishToken = null;
    if (state.undoMarkOthers) {
      state.undoMarkOthers();
      state.undoMarkOthers = null;
    }
    const index = openStack.indexOf(state);
    if (index !== -1) openStack.splice(index, 1);
    const wasOpen = state.open;
    state.open = false;
    updateNestedAttributes();
    state.releaseScroll?.();
    state.releaseScroll = null;
    if (wasOpen) popup.dispatchEvent(new CustomEvent("dialog-close", { bubbles: true }));
    state.root.remove();
    dialogs.delete(popup);
  }

  function init() {
    document.querySelectorAll("[data-tui-dialog-trigger]").forEach(listenForEscape);
    // A dialog lives as long as its SSR declaration site (_tuiPortalOwner)
    // stays in the document, including trigger-less programmatic dialogs.
    // Retire registered dialogs even when their root itself was removed.
    dialogs.forEach((state, popup) => {
      if (!state.root.isConnected || (state.root._tuiPortalOwner && !state.root._tuiPortalOwner.isConnected)) {
        destroyDialog(popup);
      }
    });
    document.querySelectorAll("[data-tui-dialog-root]").forEach((root) => {
      const popup = root.querySelector("[data-tui-dialog-content]");
      if (!popup) {
        root.remove();
        return;
      }

      if (dialogs.has(popup)) return;

      const fresh = ensureDialog(root);
      if (!fresh) return;

      if (popup.getAttribute("data-tui-dialog-initial-open") === "true") {
        // One-shot: consume the attribute so a later re-init never re-opens
        // a closed dialog.
        popup.removeAttribute("data-tui-dialog-initial-open");
        openDialog(popup);
      }
    });
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest("[data-tui-dialog-trigger]");
    if (trigger) {
      toggleDialog(dialogFor(trigger), trigger);
      return;
    }
    const closeButton = event.target.closest("[data-tui-dialog-close]");
    if (closeButton) {
      requestOpenChange(dialogFor(closeButton), false);
      return;
    }
    const backdrop = event.target.closest("[data-tui-dialog-backdrop]");
    if (backdrop) {
      handleBackdropClick(backdrop, event);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init());
  } else {
    init();
  }

  // Initialize dialogs added later (e.g. swapped in via htmx), so a
  // server-rendered dialog with Open true still opens. Also retire dialogs
  // whose source got swapped out of the DOM (releasing the scroll lock and
  // the aria-hidden marking).
  new MutationObserver(() => {
    init();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.tui = window.tui || {};
  window.tui.dialog = {
    open: openDialog,
    close: closeDialog,
    toggle: toggleDialog,
    isOpen: isDialogOpen,
  };
})();

