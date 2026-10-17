import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number" || typeof children === "bigint") return children.toString();
  if (Array.isArray(children)) return children.map(codeText).join("");
  return "";
}

export function MarkdownContent({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, node: _node, ...props }) {
            void _node;
            const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
            if (!language || !hljs.getLanguage(language)) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            const source = codeText(children).replace(/\n$/, "");
            const highlighted = hljs.highlight(source, {
              language,
              ignoreIllegals: true,
            }).value;
            return (
              <code
                className={`${className ?? ""} hljs`.trim()}
                {...props}
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
