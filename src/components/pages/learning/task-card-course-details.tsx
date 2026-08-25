import type { Locale } from "@/data/aais";
import type { getCaasiPilotTaskDefinition } from "@/data/aais-course-packages";

type CourseTaskDefinition = NonNullable<ReturnType<typeof getCaasiPilotTaskDefinition>>;

export function TaskCardCourseDetails({
  courseTask,
  locale,
  locked,
  pilotClosed,
  taskId,
}: {
  courseTask?: CourseTaskDefinition;
  locale: Locale;
  locked: boolean;
  pilotClosed: boolean;
  taskId: string;
}) {
  const cardNote = courseTask?.cardNote;
  const cardSections = courseTask?.cardSections ?? [];

  return (
    <>
      {cardNote ? (
        <p
          data-task-card-note={taskId}
          className={`mt-3 max-w-prose break-words rounded-lg border px-3 py-2 text-sm font-semibold leading-6 ${
            pilotClosed
              ? "border-[#ead39a] bg-[#fff8e8] text-[#76571a]"
              : "border-[#d7ddff] bg-[#eef2ff] text-[#3f55bb]"
          }`}
        >
          {cardNote[locale]}
        </p>
      ) : null}
      {cardSections.length ? (
        <div className="mt-4 grid gap-3">
          {cardSections.map((section) => {
            const sectionId = `aais-task-card-${taskId}-section-${section.id}`;
            return (
              <section
                key={sectionId}
                aria-labelledby={sectionId}
                className={`rounded-xl border px-4 py-3 ${
                  locked
                    ? "border-[#d8dce3] bg-white/55"
                    : "border-[#dde2eb] bg-white/80"
                }`}
              >
                <h4
                  id={sectionId}
                  className={`text-[15px] font-bold leading-6 ${
                    locked ? "text-[#5d6470]" : "text-[#242a35]"
                  }`}
                >
                  {section.title[locale]}
                </h4>
                {section.paragraphs?.map((paragraph, paragraphIndex) => (
                  <p
                    key={`${sectionId}-paragraph-${paragraphIndex}`}
                    className={`mt-2 max-w-prose break-words text-[15px] leading-7 ${
                      locked ? "text-[#686f7a]" : "text-[#555d69]"
                    }`}
                  >
                    {paragraph[locale]}
                  </p>
                ))}
                {section.bullets?.length ? (
                  <ul className={`mt-2 grid list-disc gap-2 pl-5 text-[15px] leading-7 ${
                    locked ? "text-[#686f7a]" : "text-[#555d69]"
                  }`}>
                    {section.bullets.map((bullet, bulletIndex) => (
                      <li
                        key={`${sectionId}-bullet-${bulletIndex}`}
                        className="max-w-prose break-words pl-1"
                      >
                        {bullet[locale]}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
