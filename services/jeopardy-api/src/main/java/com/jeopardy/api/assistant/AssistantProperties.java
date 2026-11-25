package com.jeopardy.api.assistant;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "jeopardy.ai")
public class AssistantProperties {

    private String provider = "azure-openai";
    private int timeoutSeconds = 25;
    private AzureOpenAi azureOpenai = new AzureOpenAi();

    public static class AzureOpenAi {
        private String endpoint = "";
        private String apiKey = "";
        private String deployment = "";
        private String apiVersion = "2024-10-21";

        public String getEndpoint() {
            return endpoint;
        }

        public void setEndpoint(String endpoint) {
            this.endpoint = endpoint;
        }

        public String getApiKey() {
            return apiKey;
        }

        public void setApiKey(String apiKey) {
            this.apiKey = apiKey;
        }

        public String getDeployment() {
            return deployment;
        }

        public void setDeployment(String deployment) {
            this.deployment = deployment;
        }

        public String getApiVersion() {
            return apiVersion;
        }

        public void setApiVersion(String apiVersion) {
            this.apiVersion = apiVersion;
        }

        public boolean isConfigured() {
            return isNonBlank(endpoint) && isNonBlank(apiKey) && isNonBlank(deployment)
                    && !endpoint.contains("REPLACE_WITH_")
                    && !apiKey.contains("REPLACE_WITH_");
        }

        private static boolean isNonBlank(String s) {
            return s != null && !s.isBlank();
        }
    }

    public boolean isConfigured() {
        return "azure-openai".equalsIgnoreCase(provider) && azureOpenai.isConfigured();
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public void setTimeoutSeconds(int timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    public AzureOpenAi getAzureOpenai() {
        return azureOpenai;
    }

    public void setAzureOpenai(AzureOpenAi azureOpenai) {
        this.azureOpenai = azureOpenai;
    }
}
