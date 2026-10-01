import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import fs from "fs";
import path from "path";
import { Navbar } from "@/components/ui/navbar";
import { Footer } from "@/components/ui/footer";
import { RichText } from "@/components/blog/rich-text";

interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  publishedAt: string;
  featuredImage: string | null;
  content: string;
}

function loadBlogPost(slug: string): BlogPost | null {
  const filePath = path.join(process.cwd(), "content", "blog", `${slug}.json`);

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BlogPost;
  } catch {
    return null;
  }
}

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = loadBlogPost(slug);

  if (!post) return { title: "Post Not Found" };

  return {
    title: `${post.title} | __PROJECT_NAME__ Blog`,
    description: post.excerpt,
    alternates: {
      canonical: `https://__DOMAIN_NAME__/blog/${slug}`,
    },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url: `https://__DOMAIN_NAME__/blog/${slug}`,
      type: "article",
      publishedTime: post.publishedAt,
      tags: post.tags,
    },
  };
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = loadBlogPost(slug);

  if (!post) notFound();

  return (
    <div className="min-h-screen bg-base-100 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-48 -left-48 w-[600px] h-[600px] rounded-full bg-primary/[0.04] blur-3xl" />
        <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] rounded-full bg-emerald-500/[0.03] blur-3xl" />
      </div>

      <Navbar />

      <main className="relative z-10">
        <article className="max-w-3xl mx-auto px-6 py-16">
          {/* Back link */}
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-sm text-base-content/40 hover:text-base-content transition-colors mb-8"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            Back to Blog
          </Link>

          {/* Header */}
          <header className="mb-8">
            {/* Tags */}
            {post.tags && post.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {post.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="text-xs font-medium px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-tight">
              {post.title}
            </h1>

            <div className="flex items-center gap-4 mt-6 text-sm text-base-content/50">
              {post.publishedAt && (
                <time dateTime={post.publishedAt}>
                  {new Date(post.publishedAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
              )}
            </div>
          </header>

          {/* Content */}
          <div className="prose prose-lg max-w-none break-words
            prose-headings:font-bold prose-headings:tracking-tight
            prose-h2:text-2xl prose-h2:mt-12 prose-h2:mb-4
            prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3
            prose-p:text-base-content/70 prose-p:leading-relaxed
            prose-a:text-primary prose-a:no-underline hover:prose-a:underline
            prose-strong:text-base-content prose-strong:font-semibold
            prose-code:text-primary prose-code:bg-base-200 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-sm prose-code:text-sm prose-code:font-normal prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-base-200 prose-pre:border prose-pre:border-base-content/10 prose-pre:rounded-xl
            prose-blockquote:border-l-primary prose-blockquote:bg-base-200/50 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:not-italic
            prose-ul:text-base-content/70 prose-ol:text-base-content/70
            prose-li:marker:text-primary
            prose-hr:border-base-content/10
            prose-img:rounded-xl prose-img:border prose-img:border-base-content/5
          ">
            <RichText content={post.content} />
          </div>

          {/* CTA */}
          <div className="mt-16 p-8 bg-base-200/50 border border-base-content/5 rounded-xl text-center">
            <h3 className="text-xl font-bold mb-2">Ready to get started?</h3>
            <p className="text-base-content/60 mb-6">
              Try __PROJECT_NAME__ free and see AI automation in action.
            </p>
            <Link href="/sign-up" className="btn btn-primary gap-2">
              Get Started Free
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
