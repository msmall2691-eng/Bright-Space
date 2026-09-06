import { useState } from 'react'
import { DollarSign } from 'lucide-react'
import { PageHeader, SubNav } from '../components/ui'
import SubcontractorPayroll from '../components/payroll/SubcontractorPayroll'

/**
 * Payouts — what the subcontractors are owed for a period.
 *
 * THIS PAGE USED TO BE PAYROLL. It pulled time-clock punches, split each crew
 * member's hours into residential vs rental and weekday vs weekend, added
 * mileage, let you edit hourly rates and push the lot into Square Payroll.
 * All of that is gone (Sept 2026): The Maine Cleaning Co. does not employ
 * cleaners, and a timecard states an hourly wage and an employment
 * relationship — the one thing a subcontractor arrangement cannot say.
 *
 * What is left is the half that still pays somebody, and it was already its
 * own component: the ledger of what each sub agreed for each job, what has
 * been generated, and what has been sent. The Employees/Subcontractors tab
 * strip went with the employees — one view needs no tabs.
 */
function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function Payroll({ role }) {
  const isAdmin = role === 'admin'
  const [startDate, setStartDate] = useState(isoDaysAgo(13))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Payouts"
        subtitle="What each subcontractor is owed for the period, at the rate they agreed."
        icon={DollarSign}
        iconColor="emerald"
      >
        <SubNav className="mb-3" />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
        </div>
      </PageHeader>

      <div className="px-4 sm:px-8 pb-8">
        <SubcontractorPayroll startDate={startDate} endDate={endDate} isAdmin={isAdmin} />
      </div>
    </div>
  )
}
