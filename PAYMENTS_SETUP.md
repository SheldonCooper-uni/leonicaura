# PayPal Setup

Diese Seite war bisher rein statisch. Für sichere PDF-Downloads brauchst du jetzt den Node-Server aus diesem Repo. GitHub Pages allein reicht dafür nicht aus, weil dort keine Webhooks und kein serverseitiger Zahlungs-Check laufen können.

## 1. Lokal starten

1. Kopiere `.env.example` nach `.env`.
2. Trage deine echten PayPal-Daten ein.
3. Installiere Abhängigkeiten mit `npm install`.
4. Starte den Server mit `npm start`.
5. Öffne danach `http://localhost:3000`.

## 2. PayPal vorbereiten

1. Erstelle in deinem PayPal Developer Dashboard eine REST App.
2. Nutze für lokale Tests `sandbox` in `PAYPAL_MODE`.
3. Trage `PAYPAL_CLIENT_ID` und `PAYPAL_CLIENT_SECRET` in deine `.env` ein.
4. Setze zusätzlich ein langes `REQUEST_TOKEN_SECRET`, damit Zahlungsanfragen serverseitig signiert geprüft werden können.
5. Lege in PayPal einen Webhook für deine Backend-URL an, zum Beispiel:
   `https://deine-domain.de/api/paypal/webhook`
6. Aktiviere mindestens diese Events:
   `CHECKOUT.ORDER.APPROVED`
   `CHECKOUT.ORDER.COMPLETED`
   `PAYMENT.CAPTURE.COMPLETED`
7. Übernimm die Webhook-ID in `PAYPAL_WEBHOOK_ID`.
8. Für Live-Zahlungen sollte die REST-App zu deinem eigenen Live-PayPal-Konto gehören.

## 3. PDFs geschützt ausliefern

1. Lege dein Komplett-PDF in `.private-assets/pdfs/`.
2. Nutze exakt den Dateinamen aus `.private-assets/pdfs/README.md` oder passe `server/products.js` an.
3. Der Download-Link wird erst nach erfolgreicher Zahlung serverseitig als Token erzeugt.
4. Der eigentliche Dateipfad steht dadurch nicht im HTML-Quelltext.

## 4. Eigene Produktbilder einfügen

1. Lege deine Fotos in `assets/produktbilder/` ab.
2. Nutze die Dateinamen aus `assets/produktbilder/README.md`.
3. Sobald die Dateien dort liegen, lädt die Startseite sie automatisch in die Scroll-Vorschau.

## 5. Deployment-Hinweis

Wenn du bei GitHub Pages bleiben willst, brauchst du das Backend auf einer separaten Plattform, zum Beispiel Render, Railway, Fly.io oder einem VPS. Einfacher ist es, Frontend und Backend zusammen über den Node-Server zu deployen.

## 6. Render-Empfehlung

Wenn du die Seite direkt veröffentlichen willst, ist Render für dieses Repo die pragmatischste Variante:

1. Push das Repo auf GitHub in den Branch `main`.
2. Erstelle bei Render einen neuen Blueprint oder Web Service aus dem Repo.
3. Nutze die `render.yaml` aus diesem Repo.
4. Hinterlege in Render alle Secrets aus `.env.example`, besonders:
   `BASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `REQUEST_TOKEN_SECRET`, `DOWNLOAD_TOKEN_SECRET`, `HCAPTCHA_SITE_KEY`, `HCAPTCHA_SECRET_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.
5. Lass `DATA_DIR` auf `/var/data/payment-data` und `PRIVATE_PDF_DIR` auf `/var/data/pdfs` zeigen.
6. Lade die PDF-Datei `LeonicAURA_Essen_v2.pdf` auf die persistente Disk nach `/var/data/pdfs/`.
7. Setze in PayPal den Live-Webhook auf `https://deine-domain.de/api/paypal/webhook`.
8. Verknüpfe danach deine Domain mit Render und aktualisiere DNS.

Wichtig: Ohne persistenten Speicher gehen lokale Bestellzustände und Download-Tokens bei Neustarts verloren. Für dieses Projekt ist eine persistente Disk daher nicht optional.