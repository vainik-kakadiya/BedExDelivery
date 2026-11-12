import { Construction } from 'lucide-react';

interface Props {
  title: string;
  requirements: string;
  milestone: string;
}

/** Marks a screen that is routed but not built yet, with the PRD items it will cover. */
export function Placeholder({ title, requirements, milestone }: Props) {
  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">{title}</h1>
      <div className="card flex items-start gap-4 p-6">
        <Construction className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div>
          <p className="font-medium">Not built yet: scheduled for {milestone}</p>
          <p className="mt-1 text-slate-600">Covers {requirements}.</p>
        </div>
      </div>
    </div>
  );
}
