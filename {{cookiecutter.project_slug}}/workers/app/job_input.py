"""A backstop for the web app's job input checks.

The web app queues only job types registered in lib/validations.ts's
`jobInputSchemas`, with input that passed the type's schema
(lib/job-submission.ts). This repeats the limits that keep a job's cost
bounded, so a job put on the queue some other way never reaches a model.
Keep it in step with lib/validations.ts when you add a job type or change
a limit.
"""

MAX_URL_LENGTH = 2048
MAX_QUESTION_LENGTH = 500

# Each job type's input fields, with the longest each may be.
JOB_INPUT_FIELDS: dict[str, dict[str, int]] = {
    "url-report": {"url": MAX_URL_LENGTH, "question": MAX_QUESTION_LENGTH},
}


class InvalidJobInput(ValueError):
    """The job's type is unknown or its input breaks the type's limits."""


def check_job_input(job_type: str, input_data: object) -> None:
    """Raise InvalidJobInput unless `input_data` is fit for `job_type`."""
    fields = JOB_INPUT_FIELDS.get(job_type)
    if fields is None:
        raise InvalidJobInput(f"unknown job type {job_type!r}")
    if not isinstance(input_data, dict):
        raise InvalidJobInput("input is not an object")
    for key, value in input_data.items():
        if key not in fields:
            raise InvalidJobInput(f"unexpected input field {key!r}")
        if not isinstance(value, str):
            raise InvalidJobInput(f"input field {key!r} is not a string")
        if len(value) > fields[key]:
            raise InvalidJobInput(f"input field {key!r} is longer than {fields[key]} characters")
