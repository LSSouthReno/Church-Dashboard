// Conference Field Guide content (Staff OS → Field Guide).
// One entry per conference. The entry with active:true is the one staff see.
// For a future conference, add a new entry here and flip `active` — no markup changes needed.
// Notes are saved per person in StaffPlans (type "conf", title = conference id).
const CONFERENCES = {
  "north-coast-2026": {
    id: "north-coast-2026",
    title: "North Coast Leadership Conference",
    eyebrow: "Staff Field Guide",
    dates: "Oct 14–15, 2026",
    location: "North Coast Church · Vista, CA",
    tagline: "From a growing church plant to a hub of gospel purpose for the next hundred years.",
    rockSource: "North Coast 2026",   // tag added to anything sent to Rocks from this conference
    active: true,
    vision: [
      "We are in a transition season between a rapidly growing church plant and an established hub of gospel purpose that will last for the next hundred years and beyond. We have to continue to lead people with a vision-centric and relational focus while also creating excellent systems to ensure the message continues to get spoken, sung, and talked about with clarity to every new person who comes through a door or into a living room.",
      "We must stay personally growing and professionally innovating in order to continue to live and lead with excellence. North Coast brings this wealth of experience in leading excellently and brings in other churches from a broad range of people interested in this same pursuit for us to spend time around, soak up vision and ideas from, and go home connected to."
    ],
    listenFor: [
      { id: "vision",     label: "Vision",     question: "How do they keep vision and relationships at the center as they grow?" },
      { id: "systems",    label: "Systems",    question: "How does the message reach every new person — at the door and in the living room?" },
      { id: "growth",     label: "Growth",     question: "What keeps their leaders growing and innovating?" },
      { id: "connection", label: "Connection", question: "Who do we need to know?" }
    ],
    breakoutSlots: [
      { id: "wed", label: "Wed · 2:45" },
      { id: "thu", label: "Thu · 10:30" }
    ],
    // Full session list so a person can switch to a different breakout
    breakoutOptions: {
      wed: ["Intelligent Church Engagement", "Leading Change Without Losing People", "Putting the Motion Back in E-Motion",
            "When Care Happens in Circles", "Developing a Small Group Game Plan", "Orbiting the Hairball",
            "Multi-Site: Taming Complexity Without Killing Passion"],
      thu: ["Put AI on Staff", "Beyond Recruiting: Creating a Volunteer Culture That Lasts", "Starving for Awe",
            "Above Reproach: Money, Trust, and Keeping Your Job", "Online as a Front Door, Not a Broadcast",
            "The Genius in the Room", "Beyond the Project", "Building an Inclusive Children’s Ministry"]
    },
    // Suggested breakouts, keyed by staff role
    suggestedBreakouts: {
      "Executive Pastor": { wed: "Leading Change Without Losing People", thu: "Put AI on Staff" },
      "Discipleship":     { wed: "When Care Happens in Circles",         thu: "Beyond the Project" },
      "Kids":             { wed: "Intelligent Church Engagement",        thu: "Building an Inclusive Children’s Ministry" },
      "Students":         { wed: "Developing a Small Group Game Plan",   thu: "Beyond Recruiting: Creating a Volunteer Culture That Lasts" },
      "Worship":          { wed: "Putting the Motion Back in E-Motion",  thu: "Starving for Awe" },
      "Tech":             { wed: "Orbiting the Hairball",                thu: "Put AI on Staff" },
      "Creative":         { wed: "Orbiting the Hairball",                thu: "Online as a Front Door, Not a Broadcast" },
      "Admin":            { wed: "Intelligent Church Engagement",        thu: "Above Reproach: Money, Trust, and Keeping Your Job" }
    },
    mainSessions: ["Main Session 1", "Main Session 2", "Main Session 3", "Main Session 4", "Main Session 5", "Main Session 6"],
    debriefNote: "We’ll debrief at our first staff meeting back."
  }
};

// Staff OS roster name → suggestedBreakouts role key. Built from the Accountability Chart
// seats (eos-data.json acc_chart). Anyone not listed sees the whole team's suggestions and
// picks their own. NEEDS BRAD'S CONFIRMATION.
const CONFERENCE_STAFF_ROLES = {
  "Brad Borowski":    "Executive Pastor",
  "Adam Carp":        "Discipleship",
  "Deana Griffin":    "Kids",        // SS Curriculum / Family Ministry Director
  "Geoffrey Caliger": "Kids",        // SS Staffing Director
  "Isaac Griffin":    "Students",
  "Katie Thompson":   "Students",
  "Gordon Fava":      "Worship",
  "John Conelea":     "Creative",
  "Rachel Primus":    "Admin"
  // Ryan Griffin (Lead Pastor) and Keith Primus (Benevolence) have no matching role key yet.
};
