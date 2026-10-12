import { Parallel, Workspace, type AML } from "@aml-jsx/sdk"

import { ReviewContextFiles } from "./components/context/files.js"
import { useReviewContext } from "./components/context/review-context.js"
import { CodePathBugHunterLane } from "./components/lanes/code-path-bug-hunter.js"
import { CorrectnessRiskTestingLane } from "./components/lanes/correctness-risk-testing.js"
import { DocumentationCommentaryLane } from "./components/lanes/documentation-commentary.js"
import { IntentContractLane } from "./components/lanes/intent-contract.js"
import { MaintainabilityEleganceLane } from "./components/lanes/maintainability-elegance.js"
import { StandardsArchitectureLane } from "./components/lanes/standards-architecture.js"
import { ReviewAcknowledgement } from "./components/phases/review-acknowledgement.js"
import { ReviewAudit } from "./components/phases/review-audit.js"
import { ReviewPublication } from "./components/phases/review-publication.js"
import { ReviewRouter } from "./components/phases/review-router.js"
import { ReviewSynthesis } from "./components/phases/review-synthesis.js"

/** The complete review workflow, including its deterministic publication edge. */
export const Review: AML.Component = () => {
  const { github } = useReviewContext()
  const workspaceId = `${github.request.repository.replaceAll("/", "-")}-pr-${github.request.prNumber}`

  return (
    <Workspace id={workspaceId} load={false} lock={false} save={false}>
      <ReviewContextFiles />
      <ReviewAcknowledgement />
      <ReviewRouter>
        <ReviewSynthesis>
          <ReviewAudit>
            <Parallel>
              <IntentContractLane />
              <StandardsArchitectureLane />
              <CodePathBugHunterLane />
              <CorrectnessRiskTestingLane />
              <DocumentationCommentaryLane />
              <MaintainabilityEleganceLane />
            </Parallel>
          </ReviewAudit>
        </ReviewSynthesis>
      </ReviewRouter>
      <ReviewPublication />
    </Workspace>
  )
}
