/* ===============================================================
   Solar Archive: buyer text for error codes (MH-16)

   Keys are the codes in api/errors.py (plus hq_timeout, which the store
   raises itself when a full-resolution render outlasts its deadline).
   infra/scripts/check.sh (error_codes) fails when a code in api/*.py has
   no key here.

   DRAFT COPY, waiting on Gilly (MH-16 Step 4.5: buyer message tone is his
   call). House rules applied: plain words, no hostnames, env var names or
   attempt counters, no em dashes, and the only product words are Original
   and Enhanced.

   buyerMessage(code, fallback): the mapped text, else the caller's own
   fallback (today's message, so an unknown code changes nothing), else a
   generic line.
   =============================================================== */

export var BUYER_MESSAGES = {
  origin_forbidden: "This page could not reach the store securely. Please reload the page and try again.",
  rate_limited: "That was a lot of requests in a short time. Please wait a minute, then try again.",
  beta_mode_blocked: "Orders are paused while the store is in beta. Your design is not lost; you can still download it.",
  server_busy: "The image server is busy right now. Please try again in a minute, or pick one of the famous moments.",
  bad_request: "Something about that date or wavelength did not work. Please pick them again.",
  preview_failed: "We could not find a solar image for that date and wavelength. Try a nearby date or another wavelength.",
  hq_timeout: "Your Enhanced image is taking longer than usual to prepare. Your other images are ready to use."
};

export var GENERIC_BUYER_MESSAGE = "Something went wrong on our end. Please try again in a moment.";

export function buyerMessage(code, fallback) {
  if (code && Object.prototype.hasOwnProperty.call(BUYER_MESSAGES, code)) return BUYER_MESSAGES[code];
  return fallback || GENERIC_BUYER_MESSAGE;
}
