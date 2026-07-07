"use client";

// Site-wide motion: Lenis smooth scrolling driven by GSAP's ticker, plus
// declarative animation hooks the server-rendered pages opt into via data
// attributes — no page needs to become a client component:
//
//   data-hero          entrance timeline on load (staggered rise + fade)
//   data-reveal        scroll-triggered rise + fade (batched, fires once)
//   data-countup       integer counts up from 0 when it enters the viewport
//
// Everything is skipped under prefers-reduced-motion; server markup is the
// no-JS baseline so content is never hidden without JavaScript.

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MotionProvider() {
  const pathname = usePathname();

  // Lenis lives for the whole session.
  useEffect(() => {
    if (prefersReducedMotion()) return;

    const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
    };
  }, []);

  // Animations re-arm on every route so client-side navigations get the same
  // reveals as a fresh load.
  useEffect(() => {
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      const heroEls = gsap.utils.toArray<HTMLElement>("[data-hero]");
      if (heroEls.length > 0) {
        gsap.from(heroEls, {
          y: 26,
          autoAlpha: 0,
          duration: 0.9,
          ease: "power3.out",
          stagger: 0.09,
          delay: 0.15,
          clearProps: "all",
        });
      }

      ScrollTrigger.batch("[data-reveal]", {
        start: "top 88%",
        once: true,
        onEnter: (els) =>
          gsap.fromTo(
            els,
            { y: 30, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.8,
              ease: "power3.out",
              stagger: 0.08,
              clearProps: "all",
            },
          ),
      });

      gsap.utils.toArray<HTMLElement>("[data-countup]").forEach((el) => {
        const end = parseInt(el.textContent ?? "", 10);
        if (!Number.isFinite(end) || end <= 0) return;
        const state = { n: 0 };
        gsap.to(state, {
          n: end,
          duration: 1.4,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
          onUpdate: () => {
            el.textContent = String(Math.round(state.n));
          },
        });
      });
    });

    return () => ctx.revert();
  }, [pathname]);

  return null;
}
