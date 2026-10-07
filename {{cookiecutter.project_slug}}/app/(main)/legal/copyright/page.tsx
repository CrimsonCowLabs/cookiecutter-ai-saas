import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import config from "@/config";

export const metadata: Metadata = {
  title: "Copyright & DMCA | __PROJECT_NAME__",
};

/**
 * The copyright policy: the designated DMCA agent (config.legal.dmcaAgent),
 * what a takedown notice and a counter-notice must contain, and the
 * repeat-infringer policy. Linked from the Terms of Service.
 */
export default function CopyrightPage() {
  const agent = config.legal.dmcaAgent;

  return (
    <LegalPage
      title="Copyright & DMCA"
      intro="How to tell us about material on __PROJECT_NAME__ that infringes your copyright, how to respond if your material was taken down, and what happens to repeat infringers."
    >
      <LegalSection title="The risk">
        <p>
          In the United States, a website that hosts material its users put
          there can be sued for that material if it infringes someone&apos;s
          copyright. A court can award statutory damages of up to $150,000 for
          each work infringed wilfully (17 U.S.C. &sect;504(c)), without the
          copyright owner having to prove any loss.
        </p>
        <p>
          The Digital Millennium Copyright Act (DMCA, 17 U.S.C. &sect;512)
          gives a site a &ldquo;safe harbor&rdquo; from those damages, but
          only if it registers a designated agent with the US Copyright Office
          to receive complaints, takes infringing material down promptly when
          properly notified, and has and enforces a policy of closing the
          accounts of repeat infringers. Figures as of October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">
            You cannot upload or publish content today.
          </strong>{" "}
          __PROJECT_NAME__ does not currently let users upload files or publish
          anything that other people can see.
        </p>
        <p>
          <strong className="text-base-content">
            This policy is ready for when you can.
          </strong>{" "}
          It applies to any content users are able to add to __PROJECT_NAME__
          in the future, and to anything else on the site you believe
          infringes your copyright.
        </p>
      </LegalSection>

      <LegalSection title="Our designated agent">
        <p>
          Send copyright notices and counter-notices to our designated agent:
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-semibold text-base-content">Name</dt>
          <dd>{agent.name}</dd>
          <dt className="font-semibold text-base-content">Postal address</dt>
          <dd className="whitespace-pre-line">{agent.postalAddress}</dd>
          <dt className="font-semibold text-base-content">Phone</dt>
          <dd>{agent.phone}</dd>
          <dt className="font-semibold text-base-content">Email</dt>
          <dd>
            <a href={`mailto:${agent.email}`} className="link link-primary">
              {agent.email}
            </a>
          </dd>
        </dl>
      </LegalSection>

      <LegalSection title="What a takedown notice must contain">
        <p>
          If you believe material on __PROJECT_NAME__ infringes your copyright,
          send our agent a written notice. Under 17 U.S.C. &sect;512(c)(3) it
          must include:
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Your physical or electronic signature, as the copyright owner or
            someone authorised to act for them.
          </li>
          <li>The copyrighted work you say is being infringed.</li>
          <li>
            The material you say is infringing, with enough detail for us to
            find it, such as its web address (URL).
          </li>
          <li>Your name, postal address, phone number and email address.</li>
          <li>
            A statement that you believe in good faith that the use is not
            authorised by the copyright owner, its agent or the law.
          </li>
          <li>
            A statement that the information in the notice is accurate and,
            under penalty of perjury, that you are the copyright owner or are
            authorised to act for them.
          </li>
        </ol>
        <p>
          A notice that leaves out these parts may not be acted on. When we
          receive a valid notice we remove or disable the material promptly
          and tell the user who posted it.
        </p>
      </LegalSection>

      <LegalSection title="Counter-notices">
        <p>
          If your material was taken down and you believe that was a mistake,
          you can send our agent a counter-notice. Under 17 U.S.C.
          &sect;512(g)(3) it must include:
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Your physical or electronic signature.</li>
          <li>
            The material that was removed, and where it appeared before it was
            removed.
          </li>
          <li>
            A statement, under penalty of perjury, that you believe in good
            faith the material was removed by mistake or because it was
            misidentified.
          </li>
          <li>Your name, postal address and phone number.</li>
          <li>
            A statement that you consent to the jurisdiction of the federal
            district court for your address or, if you are outside the United
            States, any judicial district in which we may be found, and that
            you will accept service of process from the person who sent the
            original notice, or their agent.
          </li>
        </ol>
        <p>
          We send a copy of a valid counter-notice to the person who sent the
          original notice, and put the material back between 10 and 14
          business days after we received the counter-notice, unless before
          then they tell us they have filed a court action to keep it down.
        </p>
      </LegalSection>

      <LegalSection title="Repeat infringers">
        <p>
          We close, in appropriate circumstances, the accounts of users who
          are repeat infringers: people who have been the subject of more than
          one valid takedown notice that was not answered by a successful
          counter-notice.
        </p>
        <p>
          Sending a notice or counter-notice that you know misrepresents the
          facts can make you liable for damages, including costs and
          attorneys&apos; fees (17 U.S.C. &sect;512(f)). If you are not sure
          whether material infringes your copyright, consider asking a lawyer
          first.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
