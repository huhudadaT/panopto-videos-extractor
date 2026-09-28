// Content script. Runs on the Panopto viewer page.
//
// Its one job is to answer two questions from the service worker: which session
// is open, and what does DeliveryInfo say about it. The fetch happens here
// because this context sits on the Panopto origin, so the session cookie rides
// along with no CORS negotiation at all.
//
// Written as a classic script (not a module) because content scripts declared
// in the manifest cannot be ES modules.

(() => {
  const CHANNEL = "lectern";

  function parseDeliveryId() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id") || params.get("deliveryId");
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  }

  function readPageTitle() {
    const heading = document.querySelector("#sessionTitle, .session-title, h1");
    const text = heading ? heading.textContent.trim() : "";
    return text || document.title.replace(/\s*\|\s*Panopto\s*$/i, "").trim();
  }

  async function fetchDeliveryInfo(deliveryId) {
    const body = new URLSearchParams({
      deliveryId,
      invocationId: "",
      isLiveNotes: "false",
      refreshAuthCookie: "true",
      isActiveBroadcast: "false",
      isEditing: "false",
      isKollectiveAgentInstalled: "false",
      isEmbed: "false",
      responseType: "json",
    });

    const response = await fetch(
      `${location.origin}/Panopto/Pages/Viewer/DeliveryInfo.aspx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include",
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(
        `DeliveryInfo returned ${response.status}. Try reloading the lecture page.`
      );
    }

    const payload = await response.json();
    if (!payload || !payload.Delivery) {
      throw new Error("DeliveryInfo gave an unexpected reply. Are you still signed in?");
    }
    return payload;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== CHANNEL) return undefined;

    if (message.type === "read-page") {
      sendResponse({
        ok: true,
        origin: location.origin,
        href: location.href,
        deliveryId: parseDeliveryId(),
        title: readPageTitle(),
      });
      return undefined;
    }

    if (message.type === "fetch-delivery") {
      const deliveryId = message.deliveryId || parseDeliveryId();
      if (!deliveryId) {
        sendResponse({ ok: false, error: "No Panopto session id in this page's URL." });
        return undefined;
      }
      fetchDeliveryInfo(deliveryId)
        .then((payload) =>
          sendResponse({ ok: true, origin: location.origin, deliveryId, payload })
        )
        .catch((error) =>
          sendResponse({ ok: false, error: error.message || String(error) })
        );
      return true; // keep the channel open for the async reply
    }

    return undefined;
  });
})();
