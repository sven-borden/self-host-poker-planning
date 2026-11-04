// The room settings panel's words (#25 to #31, #50): the panel, the deck field, the rule and the
// password rows, in English. A part of the catalog that loads with its panel, not with the page
// (copy-parts.ts): the keys keep their place, so `t` reads them as it reads the rest.
export const copy = {
  settings: {
    ledeOwner: "Each change reaches everyone in the room at once.",
    ledeOthers: "The product owner sets how this room plays. This is how it is set now.",
    groupCards: "Cards",
    groupRound: "Voting and reveal",
    groupPeople: "People",
    on: "On",
    off: "Off",
    saving: "Saving…",
    connectionDropped: "Not saved: the connection dropped.",
    deck: "Deck",
    deckHint: "The cards everyone picks from.",
    specials: "Special cards",
    specialsHint:
      "Extra cards to say you are unsure, need a break, or find the story too big to estimate. They never count in the results.",
    specialsNone: "None",
    timer: "Timer for each round",
    timerHint: "Each round starts with this countdown. A change applies from the next round.",
    timerThenReveal: "When it ends, the cards turn over.",
    timerThenTimeUp: "When it ends, everyone sees that time is up.",
    timerCustom: "Custom",
    timerCustomLabel: "Custom length",
    timerSet: "Set",
    timerRevealAtEnd: "Reveal when the timer ends",
    timerRevealAtEndHint:
      "When off, everyone sees that time is up and the product owner reveals the cards.",
    whoCanReveal: "Who can reveal",
    whoCanRevealHint: "Who may turn the cards over. Observers never can.",
    revealByOwner: "The product owner",
    revealByAnyone: "Anyone who votes",
    anonymous: "Anonymous voting",
    anonymousHint:
      "The results show the cards without names. A change applies from the next round.",
    roundStaysNamed: "This round still shows names.",
    roundStaysAnonymous: "This round stays anonymous.",
    revealWhenAllVotedNow: "Everyone has voted: turning this on reveals the cards.",
    revealWhenAllVoted: "Reveal when everyone has voted",
    revealWhenAllVotedHint: "The cards turn over by themselves once everyone present has voted.",
    changeAfterReveal: "Change a vote after the reveal",
    changeAfterRevealHint:
      "Voters can still change their card after the reveal. Never in an anonymous round: its votes are final once revealed.",
    changeAfterRevealLocked: "Anonymous rounds lock their votes at the reveal.",
    allowed: "Allowed",
    notAllowed: "Not allowed",
    autoAdvance: "Start the next item by itself",
    autoAdvanceHint:
      "{{seconds, number}} seconds after a final is recorded, the next item in the queue starts. Everyone sees the countdown, and the product owner can stay on the round.",
    poVotes: "The product owner votes too",
    poVotesHint: "Off, the product owner runs the session without cards.",
    observersCount: "Observers take one of the {{max, number}} places",
    observersCountHint:
      "Off, observers can still join a full room, up to {{total, number}} people in all.",
    observersCountRefused:
      "More than {{max, number}} people are here with the observers. Observers can count again once there are {{max, number}} or fewer.",
    restriction: "Who can join",
    restrictionHint:
      "Limit this room to certain accounts. Anyone holding the link sees the allowed domains, so they can choose the right account.",
    restrictionAnyone: "Anyone with the link",
    restrictionLimited: "Limited",
  },
  deckField: {
    inUse: "In use",
    use: "Use {{deck}}",
    customLabel: "Cards, separated by commas",
    customHint:
      "Up to {{max, number}} cards of up to {{length, number}} characters each, emoji too. The comma separates the cards, so write a decimal with a point: 0.5.",
    customCount_one: "{{count, number}} card",
    customCount_other: "{{count, number}} cards",
    useCustom: "Use these cards",
    fromNextRound: "New cards apply from round {{round, number}}.",
    restartsRound:
      "New cards restart round {{round, number}}: its votes are cleared, its subject stays.",
    deckQuestion_one:
      "Changing the deck restarts round {{round, number}}. The vote cast so far is cleared; the subject stays.",
    deckQuestion_other:
      "Changing the deck restarts round {{round, number}}. The {{count, number}} votes cast so far are cleared; the subject stays.",
    specialsQuestion_one:
      "Changing the special cards restarts round {{round, number}}. The vote cast so far is cleared; the subject stays.",
    specialsQuestion_other:
      "Changing the special cards restarts round {{round, number}}. The {{count, number}} votes cast so far are cleared; the subject stays.",
    restartWith: "Restart with {{deck}}",
    restartSpecials: "Restart with the new special cards",
    cancel: "Cancel",
    deck_empty: "Type at least one card.",
    deck_too_many_cards: "These are {{count, number}} cards; a deck holds at most {{max, number}}.",
    card_empty: "Card {{position, number}} is empty. Remove the extra comma.",
    card_invalid: "Card {{position, number}} holds characters that cannot be shown. Type it again.",
    card_too_long: "“{{card}}” is too long: a card holds at most {{max, number}} characters.",
    card_duplicate: "“{{card}}” is in the deck twice. Keep one.",
    card_same_value: "“{{card}}” has the same value as “{{other}}”. Keep one of them.",
    card_special:
      "“{{card}}” is a special card. Turn it on under “Special cards” instead of typing it.",
    rangeOpen: "Generate a range",
    rangeStart: "Start",
    rangeEnd: "End",
    rangeStep: "Step",
    rangeHint:
      "Numbers, with a comma or a point as the decimal mark. The cards fill the field above, where you can still edit them.",
    rangeFill: "Fill in the cards",
    rangeFilled_one: "{{count, number}} card filled in. Check it, then use it.",
    rangeFilled_other: "{{count, number}} cards filled in. Check them, then use them.",
    range_not_finite: "Type a number in start, end and step, such as 0.5 or 0,5.",
    range_step_not_positive: "The step must be more than 0.",
    range_end_before_start: "The end must not be smaller than the start.",
    range_too_many_cards:
      "That range gives more than {{max, number}} cards. Take a larger step or a shorter range.",
    range_label_too_long:
      "Some values would need more than {{max, number}} characters, such as 0.125 or 10000. Use fewer decimals or smaller numbers.",
    specialUnsure: "Not sure",
    specialCoffee: "Need a break",
    specialInfinite: "Too big to estimate",
  },
  restriction: {
    yourOrganisation: "your organisation",
    signInFirst: "Sign in to limit this room to certain accounts.",
    domainsLabel: "Email domains",
    domainsHint:
      "One a line, matched exactly: example.com does not admit mail.example.com. Only a Google account whose address Google verified counts, and that proves only that someone could once receive mail there, a shared inbox included.",
    tenantsLabel: "Microsoft tenant ids",
    tenantsHint:
      "One a line. People signing in with Microsoft pass by their organisation’s tenant id, never by their address: a domain above does not admit them.",
    googleGone: "This server no longer offers Google sign-in: nobody can pass by a domain.",
    microsoftGone: "This server no longer offers Microsoft sign-in: nobody can pass by a tenant.",
    badDomain: "This is not a domain: {{entry}}",
    badTenant: "This is not an organisation’s tenant id: {{entry}}",
    tooMany: "Each list holds {{max, number}} entries at most.",
    outsiders_one:
      "{{count, number}} person here would not pass. They stay until they reload the page, lose their connection or leave.",
    outsiders_other:
      "{{count, number}} people here would not pass. They stay until they reload the page, lose their connection or leave.",
    askFirst:
      "You do not meet this rule yourself. You stay as long as you are the product owner, but you could not come back after handing the role over.",
    removeOutsiders: "Remove everyone who would not pass",
    removeAsk_one:
      "{{count, number}} person leaves the room now, and can only come back with an account that passes.",
    removeAsk_other:
      "{{count, number}} people leave the room now, and can only come back with an account that passes.",
    removeConfirm: "Remove them",
    askConfirm: "Save it anyway",
    save: "Save the rule",
    remove: "Remove the rule",
  },
  password: {
    settingHint: "People already in the room stay. Anyone else enters it once on each device.",
    set: "Set password",
    save: "Save password",
    change: "Change password",
    remove: "Remove password",
    cancel: "Cancel",
  },
} as const;
