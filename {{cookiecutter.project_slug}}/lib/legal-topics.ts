/**
 * The compliance topics the /legal hub lists, in order. A topic gets an
 * `href` once its page exists; until then the hub names it without a link,
 * so it never points a visitor at a page that is not there.
 */
export interface LegalTopic {
  title: string;
  summary: string;
  href?: string;
}

export const legalTopics: LegalTopic[] = [
  {
    title: "Children's privacy",
    summary: "Who can create an account, and what happens with a child's data.",
    href: "/legal/children",
  },
  {
    title: "Fonts & third-party requests",
    summary: "Why no page makes your browser contact another company's server.",
    href: "/legal/fonts",
  },
  {
    title: "Analytics & recording",
    summary: "What is measured about your visit, and the choices you have.",
  },
  {
    title: "Email preferences",
    summary: "Which emails we send, and how to stop the ones you don't want.",
  },
  {
    title: "Subscriptions & renewal",
    summary: "How paid plans renew, and how to cancel.",
  },
  {
    title: "Copyright & DMCA",
    summary: "How to report content that infringes your copyright.",
  },
  {
    title: "Accessibility",
    summary: "How this app is made usable for everyone, and how to report a barrier.",
    href: "/legal/accessibility",
  },
];
