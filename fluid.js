// =====================================================
//  FLUID: the shared motion layer, used by app.js for every animation.
//
//  Why this file exists: an interface feels alive when motion starts from
//  where things are on screen right now, carries the speed of your finger,
//  and can be grabbed and reversed at any moment. Springs do all of that
//  naturally, so everything here is built on springs (from motion.min.js,
//  the "Motion" library, loaded before this file).
//
//  Think of it in three layers:
//    1. Settings: the two spring presets and the maths helpers.
//    2. Per-element values: each element gets live x / y / scale / opacity
//       numbers that write themselves into style.transform. Animating one of
//       them again mid-flight simply changes its target, keeping its speed.
//    3. Gestures: pointerDrag() tracks a finger 1:1 and reports its speed
//       when it lets go, so a spring can continue the movement seamlessly.
//
//  Everything respects "Reduce Motion" in the phone's settings: springs and
//  slides become short fades, but the information (shown / hidden) is kept.
// =====================================================

const fluid = (function () {
  const M = window.Motion;

  // ---------- 1. Settings ----------

  // Two kinds of spring, in Apple's terms: "damping" (1 = settles without
  // bouncing) and "response" (roughly how many seconds it takes to arrive).
  // Motion's "bounce" is about 1 − damping, and its "duration" is the response.
  const SPRING = {
    // For things that just appear or move: smooth, no overshoot
    default: { type: "spring", duration: 0.35, bounce: 0 },
    // For things you flicked or threw: a little bounce, because they carry momentum
    momentum: { type: "spring", duration: 0.35, bounce: 0.2 }
  };

  // Reduced motion: a short plain fade instead of any spring or slide
  const FADE = { duration: 0.2, ease: "easeOut" };

  // Does this person prefer less motion? (checked live, so it follows the setting)
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  function reduced() { return reducedQuery.matches; }

  // Where would something moving at this speed (px per second) come to rest?
  // Apple's own scroll-deceleration formula: a flick lands far, a nudge lands near.
  function project(velocity, decelerationRate) {
    const d = decelerationRate || 0.998;
    return (velocity / 1000) * d / (1 - d);
  }

  // Resistance at an edge: the further past the boundary you drag (overshoot),
  // the less the element follows. "dimension" is the size of the thing being dragged.
  function rubberband(overshoot, dimension, constant) {
    const c = constant || 0.55;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  // ---------- 2. Live values on an element ----------

  // Every element we animate gets its own set of live numbers. Writing to any of
  // them repaints the element (transform + opacity only: the properties the
  // browser can animate without re-laying out the page).
  function valuesOf(el) {
    if (el._fluid) return el._fluid;
    const v = {
      x: M.motionValue(0),
      y: M.motionValue(0),
      scale: M.motionValue(1),
      opacity: M.motionValue(1),
      blur: M.motionValue(0),
      gen: 0                      // counts show/hide requests, to spot interruptions
    };
    function paint() {
      const x = v.x.get(), y = v.y.get(), s = v.scale.get(), b = v.blur.get();
      const parts = [];
      if (x || y) parts.push("translate3d(" + x + "px, " + y + "px, 0)");
      if (s !== 1) parts.push("scale(" + s + ")");
      el.style.transform = parts.join(" ");
      el.style.opacity = v.opacity.get() === 1 ? "" : String(v.opacity.get());
      el.style.filter = b > 0.01 ? "blur(" + b + "px)" : "";
    }
    ["x", "y", "scale", "opacity", "blur"].forEach(function (k) { v[k].on("change", paint); });
    el._fluid = v;
    return v;
  }

  // Spring one live value to a target. Calling it again while it's moving just
  // re-aims it from where it is, keeping its current speed (no jump, no "brick wall").
  // "velocity" (px/s) hands over the speed of a finger that just let go.
  function springTo(value, target, options) {
    const o = Object.assign({}, reduced() ? FADE : SPRING.default, options || {});
    if (reduced()) delete o.velocity;
    return M.animate(value, target, o);
  }

  // Immediately set a value with no animation
  function jump(value, target) {
    value.jump(target);
  }

  // Show an element: un-hide it and spring it in from a small offset.
  // from = { y: 16, scale: 0.96, blur: 8 } says where it comes from; opacity always 0 → 1.
  // If it's already on its way out, it turns around from where it is.
  function show(el, from, options) {
    const v = valuesOf(el);
    const gen = ++v.gen;
    const f = from || {};
    const r = reduced();
    if (el.hidden) {
      // Starting from scratch: place it at its starting point first
      el.hidden = false;
      v.opacity.jump(0);
      v.x.jump(r ? 0 : (f.x || 0));
      v.y.jump(r ? 0 : (f.y || 0));
      v.scale.jump(r ? 1 : (f.scale === undefined ? 1 : f.scale));
      v.blur.jump(r ? 0 : (f.blur || 0));
    }
    el.style.willChange = "transform, opacity";
    const done = Promise.all([
      springTo(v.opacity, 1, options),
      springTo(v.x, 0, options),
      springTo(v.y, 0, options),
      springTo(v.scale, 1, options),
      springTo(v.blur, 0, options)
    ]);
    return done.then(function () {
      if (v.gen === gen) el.style.willChange = "";
    });
  }

  // Hide an element: spring it out to "to" (same shape as "from" above), then
  // set hidden. Along the same path it came in, so the space makes sense.
  // If it gets shown again before it's gone, it simply comes back.
  function hide(el, to, options) {
    const v = valuesOf(el);
    if (el.hidden) return Promise.resolve();
    const gen = ++v.gen;
    const t = to || {};
    const r = reduced();
    el.style.willChange = "transform, opacity";
    const done = Promise.all([
      springTo(v.opacity, 0, options),
      springTo(v.x, r ? 0 : (t.x || 0), options),
      springTo(v.y, r ? 0 : (t.y || 0), options),
      springTo(v.scale, r ? 1 : (t.scale === undefined ? 1 : t.scale), options),
      springTo(v.blur, r ? 0 : (t.blur || 0), options)
    ]);
    return done.then(function () {
      if (v.gen !== gen) return;      // something re-showed it meanwhile
      el.hidden = true;
      el.style.willChange = "";
      // Reset, so the next "show" starts clean
      v.x.jump(0); v.y.jump(0); v.scale.jump(1); v.opacity.jump(1); v.blur.jump(0);
    });
  }

  // ---------- 3. Gestures ----------

  // Follow a finger (or mouse) 1:1 on one element.
  //   options.axis: "x" or "y" — which direction counts as a drag
  //   options.onStart(info)  — the drag has begun (after ~10px, so taps aren't drags)
  //   options.onMove(info)   — every move; info.dx / info.dy are px from the start
  //   options.onEnd(info)    — finger lifted; info.vx / info.vy are px per second
  //   options.canStart(event) — optional: return false to leave this touch alone
  // Uses pointer capture, so tracking continues even if the finger leaves the element.
  function pointerDrag(el, options) {
    const axis = options.axis || "y";
    const THRESHOLD = 10;            // px of movement before we call it a drag
    let active = null;

    el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (options.canStart && options.canStart(e) === false) return;
      active = {
        id: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        // Where on the element it was grabbed — so it never jumps to the finger
        grabX: e.clientX - el.getBoundingClientRect().left,
        grabY: e.clientY - el.getBoundingClientRect().top,
        history: [],                 // the last few moves, to measure speed
        dragging: false,
        target: e.target
      };
      remember(active, e);
      // Keep receiving moves even when the pointer leaves the element. (Not when
      // it landed on a button or field: capturing there would redirect its click.)
      if (!e.target.closest("button, a, input, select, textarea, label, summary")) {
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener("pointermove", function (e) {
      if (!active || e.pointerId !== active.id) return;
      const dx = e.clientX - active.startX;
      const dy = e.clientY - active.startY;

      if (!active.dragging) {
        // Not yet a drag. Wait for a clear movement, in our direction rather than the other.
        const main = axis === "x" ? Math.abs(dx) : Math.abs(dy);
        const other = axis === "x" ? Math.abs(dy) : Math.abs(dx);
        if (main < THRESHOLD) return;
        if (other > main) { active = null; return; }   // it's a scroll, not our gesture
        active.dragging = true;
        el.setPointerCapture(e.pointerId);
        if (options.onStart) options.onStart(info(active, dx, dy, 0, 0));
      }
      remember(active, e);
      if (e.cancelable) e.preventDefault();
      if (options.onMove) options.onMove(info(active, dx, dy, 0, 0));
    });

    function finish(e) {
      if (!active || e.pointerId !== active.id) return;
      const a = active;
      active = null;
      if (!a.dragging) return;
      const dx = e.clientX - a.startX;
      const dy = e.clientY - a.startY;
      // If the finger paused before lifting, it wasn't a flick: speed is zero
      const paused = performance.now() - a.history[a.history.length - 1].t > 100;
      const vel = paused ? { vx: 0, vy: 0 } : velocity(a.history);
      if (options.onEnd) options.onEnd(info(a, dx, dy, vel.vx, vel.vy));
    }
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);

    // While dragging, the browser must not treat it as a click afterwards
    el.addEventListener("click", function (e) {
      if (el._fluidSwallowClick) { e.stopImmediatePropagation(); e.preventDefault(); el._fluidSwallowClick = false; }
    }, true);

    function info(a, dx, dy, vx, vy) {
      if (a.dragging) el._fluidSwallowClick = true;
      return { dx: dx, dy: dy, vx: vx, vy: vy, grabX: a.grabX, grabY: a.grabY, target: a.target };
    }
  }

  // Keep the last 100 ms of positions
  function remember(a, e) {
    const now = performance.now();
    a.history.push({ x: e.clientX, y: e.clientY, t: now });
    while (a.history.length > 2 && now - a.history[0].t > 100) a.history.shift();
  }

  // Speed over the last few moves, in px per second
  function velocity(history) {
    if (history.length < 2) return { vx: 0, vy: 0 };
    const first = history[0], last = history[history.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  // Which of the snap points is closest to where a flick would land?
  function nearest(points, position) {
    return points.reduce(function (best, p) {
      return Math.abs(p - position) < Math.abs(best - position) ? p : best;
    });
  }

  return {
    SPRING: SPRING, FADE: FADE, reduced: reduced,
    project: project, rubberband: rubberband, nearest: nearest,
    valuesOf: valuesOf, springTo: springTo, jump: jump, show: show, hide: hide,
    pointerDrag: pointerDrag
  };
})();
