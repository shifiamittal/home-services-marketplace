self.addEventListener("push", event => {
  let payload = { title: "Nivasa", body: "You have a booking update.", url: "/", tag: "nivasa-update" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Use the safe fallback message when a push payload cannot be read.
  }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: payload.tag,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => "focus" in client);
      if (existing) return existing.focus();
      return self.clients.openWindow(event.notification.data?.url || "/");
    }),
  );
});
