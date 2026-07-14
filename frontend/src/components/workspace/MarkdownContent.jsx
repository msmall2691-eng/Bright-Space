import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Renders an agent's markdown reply (headers, bold, tables, lists, code) as
 * actual formatted content instead of literal "**bold**"/"##"/"| a | b |"
 * text. Agents write GitHub-flavored markdown routinely (tables of action
 * items, checklists, etc.) — without this it reads as a wall of symbols,
 * which is most of why a long reply felt like "a mess" to skim.
 *
 * Renders to React elements (not dangerouslySetInnerHTML), so this is safe
 * by construction — no HTML injection surface even though the source text
 * comes from an LLM.
 *
 * Every heading level is scaled DOWN from the app's global h1–h5 rules
 * (index.css sets h1 to text-3xl — appropriate for a page title, not a
 * line inside a chat bubble) via explicit component overrides below.
 */
export default function MarkdownContent({ text }) {
  return (
    <div className="markdown-body text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <div className="text-[15px] font-bold text-ink mt-2 mb-1 first:mt-0">{children}</div>,
          h2: ({ children }) => <div className="text-[14px] font-bold text-ink mt-2 mb-1 first:mt-0">{children}</div>,
          h3: ({ children }) => <div className="text-[13px] font-bold text-ink mt-2 mb-1 first:mt-0">{children}</div>,
          h4: ({ children }) => <div className="text-[13px] font-semibold text-ink mt-1.5 mb-1 first:mt-0">{children}</div>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-700">
              {children}
            </a>
          ),
          // react-markdown v9+ no longer passes an `inline` prop to the code
          // renderer (fenced vs. inline is now conveyed structurally: a
          // fenced block's <code> is nested inside a <pre>, inline code's
          // isn't) — override `pre` for the block case and reset the nested
          // <code>'s own styling there so it doesn't double up.
          pre: ({ children }) => (
            <pre className="p-2 rounded-lg bg-bg-2 text-[12px] font-mono overflow-x-auto whitespace-pre mb-2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:rounded-none">
              {children}
            </pre>
          ),
          code: ({ children }) => (
            <code className="px-1 py-0.5 rounded bg-bg-2 text-[12px] font-mono">{children}</code>
          ),
          hr: () => <hr className="my-2 border-hairline" />,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-hairline-2 pl-3 my-2 text-ink-2">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-lg border border-hairline">
              <table className="w-full text-[12px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-bg-2">{children}</thead>,
          th: ({ children }) => <th className="text-left font-semibold px-2.5 py-1.5 border-b border-hairline">{children}</th>,
          td: ({ children }) => <td className="px-2.5 py-1.5 border-b border-hairline align-top">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
