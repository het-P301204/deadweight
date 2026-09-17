/**
 * Error boundary.
 *
 * A render failure in one view must not take the whole tool down with no
 * explanation, and it must not spill a stack trace into the page. The
 * boundary shows what happened, why it matters and what to do, with the
 * technical detail behind a disclosure -- the same shape as every other error
 * in the product.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

import { Button, ErrorState } from './primitives.tsx'

interface Props {
  readonly children: ReactNode
  readonly onReset?: () => void
}

interface State {
  readonly error: Error | null
  readonly stack: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null, stack: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, stack: info.componentStack ?? null })
  }

  override render(): ReactNode {
    const { error, stack } = this.state
    if (error === null) return this.props.children

    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <ErrorState
          what="The interface stopped rendering this view."
          why="The analysis itself may have completed. What you would be looking at now is a partial screen rather than an empty one, which is worse than a clear stop."
          fix="Reload, or start over with the project. If it repeats on the same project, the detail below identifies where."
          detail={`${error.name}: ${error.message}${stack === null ? '' : `\n${stack}`}`}
          actions={
            <>
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
              {this.props.onReset !== undefined && (
                <Button
                  onClick={() => {
                    this.setState({ error: null, stack: null })
                    this.props.onReset?.()
                  }}
                >
                  Start over
                </Button>
              )}
            </>
          }
        />
      </div>
    )
  }
}
