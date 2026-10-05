import { ArrowLeft } from 'lucide-react'
import credits from './credits.json'
import './credits.css'

type Credit = {
  name: string
  version: string
  license: string
  author: string
  url: string
  group: string
  note?: string
}

const GROUPS = ['App UI libraries', 'Host/engine libraries', 'Models', 'Tools', 'Fonts & assets']

export function Credits({ onBack }: { onBack: () => void }) {
  const items = credits as Credit[]

  return (
    <div className="credits">
      <header className="credits-head">
        <button className="credits-back" type="button" onClick={onBack} autoFocus>
          <ArrowLeft size={16} aria-hidden /> Back
        </button>
      </header>
      <main className="credits-main">
        <div className="credits-intro">
          <p className="credits-kicker">About Mizan</p>
          <h1>Credits</h1>
          <p>
            Mizan is built with open-source libraries, models, fonts, and system tools.
            Full license texts and redistribution notes are included with the source.
          </p>
        </div>

        {GROUPS.map((group, index) => {
          const groupItems = items.filter((item) => item.group === group)
          const headingId = `credits-group-${index}`
          return (
            <section className="credits-group" aria-labelledby={headingId} key={group}>
              <h2 id={headingId}>{group}</h2>
              <div className="credits-list">
                {groupItems.map((item) => (
                  <article className="credit" key={`${item.group}:${item.name}`}>
                    <div className="credit-title">
                      <h3>
                        <a href={item.url} target="_blank" rel="noreferrer">{item.name}</a>
                      </h3>
                      <span>{item.version}</span>
                    </div>
                    <p className="credit-license">{item.license}</p>
                    <p className="credit-author">{item.author}</p>
                    {item.note && <p className="credit-note">{item.note}</p>}
                  </article>
                ))}
              </div>
            </section>
          )
        })}

        <p className="credits-foot">
          YouTube thumbnails and media belong to their respective owners. Mizan does not bundle them.
        </p>
      </main>
    </div>
  )
}
