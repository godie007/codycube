export const TEMPLATES: Record<string, string> = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mi-app
  namespace: __NAMESPACE__
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mi-app
  template:
    metadata:
      labels:
        app: mi-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  Pod: `apiVersion: v1
kind: Pod
metadata:
  name: mi-pod
  namespace: __NAMESPACE__
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "while true; do date; sleep 5; done"]
`,
  Service: `apiVersion: v1
kind: Service
metadata:
  name: mi-servicio
  namespace: __NAMESPACE__
spec:
  selector:
    app: mi-app
  ports:
    - port: 80
      targetPort: 80
`,
  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: mi-config
  namespace: __NAMESPACE__
data:
  clave: valor
`,
  Secret: `apiVersion: v1
kind: Secret
metadata:
  name: mi-secreto
  namespace: __NAMESPACE__
type: Opaque
stringData:
  clave: valor
`,
  Job: `apiVersion: batch/v1
kind: Job
metadata:
  name: mi-job
  namespace: __NAMESPACE__
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo hola"]
`,
  CronJob: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: mi-cronjob
  namespace: __NAMESPACE__
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "echo hola"]
`,
  Ingress: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mi-ingress
  namespace: __NAMESPACE__
spec:
  rules:
    - host: ejemplo.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: mi-servicio
                port:
                  number: 80
`,
  PersistentVolumeClaim: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mi-volumen
  namespace: __NAMESPACE__
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: mi-namespace
`
}
