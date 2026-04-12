# LeonicAURA

Landingpage und Node-Backend für Unterrichtsanfragen, PayPal-Zahlungen und geschützte PDF-Downloads.

## Lokal starten

1. `.env.example` nach `.env` kopieren.
2. hCaptcha-, SMTP- und PayPal-Daten eintragen.
3. `npm install` ausführen.
4. `npm start` starten.
5. `http://localhost:3000` öffnen.

## Kontaktformular

Das Kontaktformular auf der Startseite sendet an `/api/contact` und ist serverseitig abgesichert durch:

- `X-Request-Token` und Same-Origin-Prüfung
- Rate-Limit pro IP
- hCaptcha-Validierung über `HCAPTCHA_SITE_KEY` und `HCAPTCHA_SECRET_KEY`
- SMTP-Mailversand über `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` und `SMTP_PASS`

Optional:

- `CONTACT_TO_EMAIL` überschreibt die Zieladresse.
- `CONTACT_FROM_EMAIL` setzt die Absenderadresse für den SMTP-Versand.

## Zahlungen

PayPal-Setup und geschützte PDF-Downloads sind zusätzlich in [PAYMENTS_SETUP.md](PAYMENTS_SETUP.md) beschrieben.

## Deployment

Für diese Website ist ein Node-Host nötig. GitHub Pages allein reicht nicht, weil Kontaktformular, PayPal-Webhooks und geschützte Downloads serverseitig laufen.

Im Repo liegt dafür eine [render.yaml](render.yaml), damit das Projekt als Render-Web-Service mit persistentem Speicher gestartet werden kann.
