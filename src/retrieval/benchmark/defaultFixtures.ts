/**
 * Independent raw-response fixtures for the reviewed offline workflow.
 *
 * These values are intentionally separate from the benchmark corpus. A corpus
 * edit therefore cannot silently manufacture a matching business response;
 * the fixture catalog must be reviewed and updated as a separate artifact.
 */
export interface PublisherWorkflowFixture {
  readonly landingUrl: string;
  readonly doi: string;
  readonly title: string;
  readonly candidateUrl: string;
}

export interface ScholarWorkflowFixture {
  readonly query: string;
  readonly title: string;
}

export const DEFAULT_PUBLISHER_WORKFLOW_FIXTURES: Readonly<Record<string, PublisherWorkflowFixture>> = {
  'pub-01': { landingUrl: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0198468', doi: '10.1371/journal.pone.0198468', title: 'Eliciting improved quantitative judgements using the IDEA protocol: A case study in natural resource management', candidateUrl: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0198468&type=printable' },
  'pub-02': { landingUrl: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0205194', doi: '10.1371/journal.pone.0205194', title: 'Oral carbon monoxide therapy in murine sickle cell disease: Beneficial effects on vaso-occlusion, inflammation and anemia', candidateUrl: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0205194&type=printable' },
  'pub-03': { landingUrl: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0201358', doi: '10.1371/journal.pone.0201358', title: 'How selfish is a thirsty man? A pilot study on comparing sharing behavior with primary and secondary rewards', candidateUrl: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0201358&type=printable' },
  'pub-04': { landingUrl: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0205139', doi: '10.1371/journal.pone.0205139', title: 'First-in-human randomized controlled trial of an oral, replicating adenovirus 26 vector vaccine for HIV-1', candidateUrl: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0205139&type=printable' },
  'pub-05': { landingUrl: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0190420', doi: '10.1371/journal.pone.0190420', title: 'Real-time estimation of horizontal gaze angle by saccade integration using in-ear electrooculography', candidateUrl: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0190420&type=printable' },
  'pub-06': { landingUrl: 'https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.00374/full', doi: '10.3389/fpsyg.2019.00374', title: 'The Graded Fate of Unattended Stimulus Representations in Visuospatial Working Memory', candidateUrl: 'https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.00374/pdf' },
  'pub-07': { landingUrl: 'https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2019.00028/full', doi: '10.3389/fnhum.2019.00028', title: 'A Non-cognitive Behavioral Model for Interpreting Functional Neuroimaging Studies', candidateUrl: 'https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2019.00028/pdf' },
  'pub-08': { landingUrl: 'https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.01561/full', doi: '10.3389/fpsyg.2019.01561', title: 'Hyperscanning and Neural Dynamics of Emotion Processing During Guided Imagery and Music', candidateUrl: 'https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.01561/pdf' },
  'pub-09': { landingUrl: 'https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2019.00340/full', doi: '10.3389/fnhum.2019.00340', title: 'Brainstem Modulation of Large-Scale Intrinsic Cortical Activity Correlations', candidateUrl: 'https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2019.00340/pdf' },
  'pub-10': { landingUrl: 'https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2019.00248/full', doi: '10.3389/fnins.2019.00248', title: 'Fusing Mobile Phone Sensing and Brain Imaging to Assess Depression in College Students', candidateUrl: 'https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2019.00248/pdf' },
  'pub-11': { landingUrl: 'https://www.mdpi.com/1660-4601/17/1/84', doi: '10.3390/ijerph17010084', title: 'Effect of Land Use Conversion on Surface Soil Heavy Metal Contamination in a Typical Karst Plateau Lakeshore Wetland of Southwest China', candidateUrl: 'https://www.mdpi.com/1660-4601/17/1/84/pdf' },
  'pub-12': { landingUrl: 'https://www.mdpi.com/1660-4601/17/13/4865', doi: '10.3390/ijerph17134865', title: 'Effects of Climate Change on Land Cover Change and Vegetation Dynamics in Xinjiang, China', candidateUrl: 'https://www.mdpi.com/1660-4601/17/13/4865/pdf' },
  'pub-13': { landingUrl: 'https://www.mdpi.com/1660-4601/17/20/7384', doi: '10.3390/ijerph17207384', title: 'Soil Phosphorus Pools, Bioavailability and Environmental Risk in Response to the Phosphorus Supply in the Red Soil of Southern China', candidateUrl: 'https://www.mdpi.com/1660-4601/17/20/7384/pdf' },
  'pub-14': { landingUrl: 'https://www.mdpi.com/1660-4601/17/24/9214', doi: '10.3390/ijerph17249214', title: 'Metal Fractionation in Surface Sediments of the Brahmaputra River and Implications for Their Mobilization', candidateUrl: 'https://www.mdpi.com/1660-4601/17/24/9214/pdf' },
  'pub-15': { landingUrl: 'https://www.mdpi.com/1660-4601/17/17/6131', doi: '10.3390/ijerph17176131', title: 'An Early Warning System for Flood Detection Using Critical Slowing Down', candidateUrl: 'https://www.mdpi.com/1660-4601/17/17/6131/pdf' },
  'pub-16': { landingUrl: 'https://bmcbiol.biomedcentral.com/articles/10.1186/s12915-019-0675-z', doi: '10.1186/s12915-019-0675-z', title: 'RNA processing errors triggered by cadmium and integrator complex disruption are signals for environmental stress', candidateUrl: 'https://bmcbiol.biomedcentral.com/counter/pdf/10.1186/s12915-019-0675-z.pdf' },
  'pub-17': { landingUrl: 'https://bmcprimcare.biomedcentral.com/articles/10.1186/s12875-019-0943-6', doi: '10.1186/s12875-019-0943-6', title: 'A multidisciplinary self-management intervention among patients with multimorbidity and the impact of socioeconomic factors on results', candidateUrl: 'https://bmcprimcare.biomedcentral.com/counter/pdf/10.1186/s12875-019-0943-6.pdf' },
  'pub-18': { landingUrl: 'https://bmcmedresmethodol.biomedcentral.com/articles/10.1186/s12874-019-0895-5', doi: '10.1186/s12874-019-0895-5', title: 'Using research networks to generate trustworthy qualitative public health research findings from multiple contexts', candidateUrl: 'https://bmcmedresmethodol.biomedcentral.com/counter/pdf/10.1186/s12874-019-0895-5.pdf' },
  'pub-19': { landingUrl: 'https://implementationscience.biomedcentral.com/articles/10.1186/s13012-020-0972-5', doi: '10.1186/s13012-020-0972-5', title: 'Adapting rapid assessment procedures for implementation research using a team-based approach to analysis: a case example of patient quality and safety interventions in the ICU', candidateUrl: 'https://implementationscience.biomedcentral.com/counter/pdf/10.1186/s13012-020-0972-5.pdf' },
  'pub-20': { landingUrl: 'https://bmcpalliatcare.biomedcentral.com/articles/10.1186/s12904-020-00647-5', doi: '10.1186/s12904-020-00647-5', title: 'Co-construction of the family-focused support conversation: a participatory learning and action research study to implement support for family members whose relatives are being discharged for end-of-life care at home or in a nursing home', candidateUrl: 'https://bmcpalliatcare.biomedcentral.com/counter/pdf/10.1186/s12904-020-00647-5.pdf' }
};

export const DEFAULT_SCHOLAR_WORKFLOW_FIXTURES: Readonly<Record<string, ScholarWorkflowFixture>> = {
  'sch-01': { query: 'attention mechanisms neural networks', title: 'Attention Is All You Need' },
  'sch-02': { query: 'deep residual learning image recognition', title: 'Deep Residual Learning for Image Recognition' },
  'sch-03': { query: 'BERT language representation', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding' },
  'sch-04': { query: 'Adam method stochastic optimization', title: 'Adam: A Method for Stochastic Optimization' },
  'sch-05': { query: 'ImageNet large scale visual recognition', title: 'ImageNet: A large-scale hierarchical image database' },
  'sch-06': { query: 'unreasonable effectiveness of data', title: 'The Unreasonable Effectiveness of Data' },
  'sch-07': { query: 'random forests classification', title: 'Random Forests' },
  'sch-08': { query: 'generative adversarial nets', title: 'Generative Adversarial Nets' },
  'sch-09': { query: 'You Only Look Once object detection', title: 'You Only Look Once: Unified, Real-Time Object Detection' },
  'sch-10': { query: 'Monte Carlo tree search survey', title: 'A Survey of Monte Carlo Tree Search Methods' }
};
