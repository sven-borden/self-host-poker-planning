# Glossary

The words the interface uses, in English, French and German. A string that names one of
these things uses the word below, in `apps/web/src/i18n/` and in the account page's copy
(`apps/web/src/account/account-copy.ts`). A new string starts here; a new word gets a row.

The reader is **vous** in French and **Sie** in German, everywhere, to everyone (OQ-2,
ADR-012). `i18n.test.ts` fails on the informal pronouns and on a list of imperatives, not on
every informal form; a review still reads the screens.

## The round

| English | French | German | Notes, and what to avoid |
|---|---|---|---|
| room | la salle | der Raum | Not "la pièce", "le salon". |
| round | le tour | die Runde | "Tour suivant", "Nächste Runde". Not "la manche": a team does not play to win. |
| card | la carte | die Karte | |
| deck | le jeu de cartes, le jeu | das Kartendeck | German: not "Kartensatz", not "Deck" alone. French: not "le deck", not "le paquet". |
| special card | la carte spéciale | die Sonderkarte | ?, ☕ and ∞. They never count. |
| to vote | voter | abstimmen | Voting is what a person does; the button that opens it says "Lancer le vote", "Runde starten". |
| vote | le vote | die Stimme | A person's one card in a round. The act as a whole is "le vote", "die Abstimmung". Not "Votum". |
| to reveal | révéler | aufdecken | **Every instruction, button, setting and error.** French may say the cards "se retournent" only to describe what is seen happening. German "umdrehen" likewise. |
| the reveal | la révélation | das Aufdecken | German: not "Aufdeckung". |
| results | les résultats | die Ergebnisse | |
| agreement | l’accord | die Einigkeit | The percentage. Consensus is what 100 % is called. |
| consensus | le consensus | der Konsens | |
| spread | l’écart | die Spanne | French "les écarts" also for the differences the team discusses; German "die Unterschiede". |
| estimate | l’estimation (f.) | die Schätzung | |
| final estimate | l’estimation finale | die endgültige Schätzung | The history's short label: "Finale", "Endgültig". German: not "Endschätzung", not "Final". |
| to record (a final) | enregistrer | festhalten | German: not "erfassen", not "speichern": a person decides, a form does not save. |
| subject | le sujet | das Thema | What a round is about: a title, a link or both. |
| timer | le minuteur | der Timer | German: "Timer" is the word a team says and the word the sound settings used; not "Zeitlimit", not "Stoppuhr". "Countdown" for what people watch run. |
| hand | la main | die Hand | Spoken as "Vos cartes", "Ihre Karten". |

## People

| English | French | German | Notes, and what to avoid |
|---|---|---|---|
| product owner | le product owner | der Product Owner | Masculine in both, the Scrum role's name, never translated. Lower case in French, capitals in German. "PO" only where space is short. German genitive: "des Product Owners". |
| voter | le votant | (abstimmen) | German names the action, not the person: the role is "Abstimmen", and sentences say "wer abstimmt", "alle, die abstimmen". |
| observer | l’observateur | der Beobachter; the role: "Beobachten" | German as for voter: the choice on the join form is a verb. |
| guest | l’invité | der Gast | Someone without an account. |
| seat, place | la place | der Platz | "Prenez place", "Nehmen Sie Platz". A room has 16. |
| at the table | à la table | am Tisch | |
| away | hors ligne | abwesend | |
| to join | rejoindre | beitreten | French "entrer" stays where it is natural: "vous pourrez entrer", "la salle est libre", a person coming in. German: "dem Raum beitreten" in sentences; the one button says "Raum betreten", because "Raum beitreten" is not a sentence. |
| to remove (someone) | retirer | entfernen | Not "expulser", not "rauswerfen". |
| to run a room | animer | leiten | French: not "diriger". |
| to hand over, to claim (the role) | confier, prendre | übergeben, übernehmen | |
| keeper, whom a room belongs to | le propriétaire | gehört (verb) | The person who may delete the room. "La salle lui appartient", "der Raum gehört ihr". Not "détenteur", not "Inhaber" in a heading. |

## The queue

| English | French | German | Notes, and what to avoid |
|---|---|---|---|
| queue | la file d’attente, la file | die Warteschlange | The UI has no "backlog": that is the tool the tickets come from. Not "le backlog", not "Liste" as the feature's name. |
| item | le ticket | der Eintrag | One line of the queue. German keeps "Ticket" for what people paste from a tracker ("Tickets einfügen", "Link zum Ticket"). |
| key | la clé | der Schlüssel | ABC-123. |
| next | ensuite | als Nächstes | |
| history | l’historique (m.) | der Verlauf | Not "Historie". |
| summary | le résumé | die Zusammenfassung | |
| export | exporter | exportieren | "Export" stays as a noun. |

## Sign-in and connectors

| English | French | German | Notes, and what to avoid |
|---|---|---|---|
| to sign in, to sign out | se connecter, se déconnecter | sich anmelden, sich abmelden | |
| sign-in | la connexion | die Anmeldung | French "connexion" is also the network's: the sentence must say which. |
| account | le compte | das Konto | Not "Account". |
| connector | (none) | (none) | The interface says "Connecter Jira", "Jira verbinden": a person connects a system. The word itself is for this repo. |
| to connect | connecter | verbinden | |
| token | le jeton | das Token | Neuter in German, as Microsoft writes it. |
| personal access token | le jeton d’accès personnel | das persönliche Zugriffstoken | Microsoft's words. |
| site (Jira) | le site | die Website | Atlassian's words. |
| board (Jira) | le tableau | das Board | Atlassian's words. |
| sprint | le sprint | der Sprint | |
| query | la requête | die Abfrage | Microsoft's words; German "Suche" only for a Jira search. |
| work item | l’élément de travail | das Arbeitselement | Microsoft's words. |
| tenant | le locataire; "ID de locataire" | der Mandant; "Mandanten-ID" | Microsoft's words in its French and German portals. |
| domain | le domaine | die Domain | |
| scope (a token's permission) | l’autorisation | der Bereich | Not "portée", not "Scope". Microsoft's own field names stay (below). |

Product names stay as they are: Poker Planning, Jira, Azure DevOps, Google, Microsoft,
Atlassian. So do the names a tool gives its own fields and permissions, where a person must
find them on its screens: Story Points, Effort, Size, Work Items, Read & write.

## Typography

- French: a narrow no-break space (U+202F) before `:` `;` `!` `?` and inside « », a
  typographic apostrophe (’), and a million as "1 000 000 de personnes" in every `_many`.
- German: „so“, and a capital after a colon that starts a sentence.
- Both: `…` as one character, with no space before it in a status such as "Wird gespeichert…".
- German: a soft hyphen (U+00AD) in a short label a phone's narrow box may have to break, as in
  "Endgültig" in the results' centre.

`i18n.test.ts` holds what a machine can check: the informal pronouns and a list of imperatives,
the capital Sie, the apostrophes and quotes, no space before `…`, "de" or "d’" after the
number in every French `_many`, and `app.description` equal to the sentence in `index.html`.
