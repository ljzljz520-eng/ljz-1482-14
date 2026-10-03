import { Component, ErrorInfo, ReactNode } from "react";
import { toast } from "react-hot-toast";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(): void {
    toast.error("页面出现小问题，已为你记录。");
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center bg-white">
          <div className="max-w-md text-center space-y-4">
            <p className="text-3xl font-semibold text-slate-900">出错了</p>
            <p className="text-slate-500">请刷新页面或返回首页。</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
