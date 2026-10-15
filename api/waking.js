/* ===============================================================
   Solar Archive: the one automatic retry after a cold start (MH-12)

   The Fly machine scales to zero between visits, and the first heavy call
   after a nap can fail once while it wakes. These helpers decide which
   failures are the wake (worth one retry once /api/health answers) and
   which are real answers from the app (never retried).

   A wake failure is either
     - a network error: fetch rejected (Chrome "Failed to fetch", Safari
       "Load failed", Firefox "NetworkError when attempting to fetch
       resource."), or fetchWithTimeout's friendlier error for the same
       case, which it marks with wakeNetwork = true; or
     - a 502, 503 or 504 whose body is NOT the app's JSON. The app itself
       answers 502 for "no VSO data" and 503 for "server is busy", always
       as JSON; those are real answers and are not retried. A gateway page
       (HTML or empty) is what the edge or the Fly proxy sends while the
       machine is down.

   Pure functions, no DOM: tested by api/scripts/test_waking.mjs.
   =============================================================== */

var NETWORK_MESSAGES = /Failed to fetch|Load failed|NetworkError when attempting to fetch resource/;

export function gatewayError(status, contentType) {
  if (status < 502 || status > 504) return null;
  if (String(contentType || "").toLowerCase().indexOf("application/json") !== -1) return null;
  var err = new Error("The image server is waking up (" + status + ").");
  err.wakeGateway = true;
  err.httpStatus = status;
  return err;
}

export function isWakeFailure(err) {
  if (!err) return false;
  if (err.wakeGateway === true || err.wakeNetwork === true) return true;
  return err.name === "TypeError" && NETWORK_MESSAGES.test(String(err.message || ""));
}

// attempt():   returns a Promise for one try of the request.
// waitAwake(): returns a Promise that resolves once /api/health answers and
//              rejects if the server stays down.
// onRetry():   optional; called once, when the retry is decided.
// On a wake failure the request is tried exactly once more, after
// waitAwake() resolves. If the server stays down, the ORIGINAL error is
// what the caller sees, so its message stays the true one.
export function retryOnceAfterWake(attempt, waitAwake, onRetry) {
  return attempt().catch(function (err) {
    if (!isWakeFailure(err)) throw err;
    if (onRetry) onRetry(err);
    return waitAwake().then(function () { return attempt(); }, function () { throw err; });
  });
}
