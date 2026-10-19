---
name: go
description: >-
  Den naechsten offenen Punkt aus NEXT.md nehmen und kleinteilig bis zum Ende
  durchziehen. Nutzen bei "/go", "/go 3", "/go <stichwort>", "mach weiter",
  "nimm den naechsten Punkt". Ohne Argument wird der oberste offene Punkt
  genommen. Gegenstueck zu /whats-next, das nur auflistet.
---

# /go

Einen Punkt. Bis fertig.

## Welcher Punkt

- `/go` ohne Argument → Punkt 1 aus `NEXT.md` (der oberste offene).
- `/go 3` → Punkt 3.
- `/go <stichwort>` → der Punkt, auf den das Stichwort passt. Passt es auf
  mehrere oder auf keinen: einmal kurz nachfragen, nicht raten.

Zu Beginn **eine Zeile**, welcher Punkt genommen wird. Dann losarbeiten.

## Fortsetzung nach /clear

Beginnen die Argumente mit „Fortsetzung nach /clear“ (token-optimizer hat
`/compress` → `/clear` → `/go` ausgeführt), war die Sitzung mitten in der
Arbeit. Dann:

- Den Punkt aus der Zeile `Gerade dran:` in `NEXT.md` nehmen und **bei dem
  dort genannten Schritt weitermachen** — nicht von vorn anfangen, nicht
  erst auflisten. Fehlt die Zeile oder steht `–` darin: Punkt 1.
- Steht unter `Wartet auf:` eine offene Frage an den Nutzer: nicht arbeiten,
  sondern nur diese Frage stellen.
- Den Ist-Zustand kurz prüfen (git status, Datei, laufender Prozess), bevor
  weitergemacht wird: was vor dem `/clear` schon erledigt war, nicht doppelt
  tun.

## Autorisierungen aus NEXT.md

Steht in `NEXT.md` ein Abschnitt `## Autorisierungen`, gelten die dort
erteilten Freigaben weiter: nicht erneut fragen, nicht darauf warten. Vor dem
Abschluss pruefen, ob davon noch Schritte offen sind, und sie ausfuehren. Die
„NICHT"-Grenzen sind genauso verbindlich. Eine Freigabe deckt nur die Art
Schritt und den Gegenstand, fuer die sie notiert ist; ist der Stand ein
anderer (Tests rot, anderes Ziel), anhalten und nachfragen.

## Wie gearbeitet wird

Kleinteilig heisst: in Schritten, die einzeln nachvollziehbar und einzeln
zurueckdrehbar sind.

- **Erst lesen, dann aendern.** Den betroffenen Code, die Konfiguration, den
  Ist-Zustand auf der Maschine — bevor etwas angefasst wird.
- **Ein Schritt, eine Pruefung.** Nach jeder Aenderung feststellen, ob sie das
  tut, was sie soll. Nicht drei Dinge aendern und am Ende hoffen.
- **Vor Eingriffen an Produktivsystemen sichern**, und zwar so, dass der Weg
  zurueck bekannt ist (Snapshot, Dump, Kopie der Datei — was passt). Den
  Rueckweg im Bericht nennen.
- **Tests, wo es welche gibt.** Neue Pruefungen so bauen, dass sie ohne den Fix
  fehlschlagen — sonst beweisen sie nichts. Das einmal gegenpruefen.
- **Nicht schweigend ausweiten.** Faellt unterwegs etwas anderes auf: notieren
  und nach NEXT.md, nicht nebenbei miterledigen. Ausnahme ist, was sonst den
  aktuellen Punkt kaputt macht — dann dazusagen, warum.
- **Stolpert es**, nicht durchdruecken: zurueckrollen, Ursache suchen, sauber
  neu ansetzen. Ein zurueckgerollter Versuch gehoert in den Bericht.

## Wenn fertig

1. `NEXT.md` pflegen: Punkt nach `## Erledigt` mit Datum, unterwegs
   aufgetauchtes Neues oben einsortieren.
2. Gibt es ein verknuepftes Odoo-Ticket (URL steht in der `TASK.md`), eine
   kurze Notiz dorthin — per DayTask, wie in der globalen CLAUDE.md
   beschrieben.
3. **Kurz berichten**: was getan wurde, womit es geprueft ist, was offen
   blieb. Keine Nacherzaehlung jedes Schrittes.

Danach aufhoeren. Nicht ungefragt den naechsten Punkt anfangen — dafuer gibt es
wieder `/go`.

## Wann nachgefragt wird

Nur wenn es ohne Antwort schiefgehen kann: wenn zwei Lesarten des Punktes zu
deutlich unterschiedlicher Arbeit fuehren, oder wenn ein Schritt ausserhalb
dessen liegt, was der Punkt erkennbar meint (fremde Aenderungen mitnehmen,
Produktivdaten anfassen, etwas Unumkehrbares). Sonst entscheiden und die
Entscheidung im Bericht sichtbar machen.
